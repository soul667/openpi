import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CHECKPOINTS_ROOT, REPO_ROOT } from "./paths.js";
import { getRemoteHost, listRemoteHosts, prepareRemoteCheckpointDirForRsync, sshExec } from "./remotes.js";
import { RemoteHost } from "./types.js";

const execFileAsync = promisify(execFile);

export interface TrainExperimentInfo {
  source: "local" | "remote";
  hostId?: string;
  hostLabel?: string;
  configName: string;
  expName: string;
  runRelativePath: string;
  localRunPath: string;
  mtimeMs: number;
  steps: number[];
  backendHint?: "jax" | "torch";
}

function shellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function rsyncSsh(host: RemoteHost): string {
  return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", ...(host.sshArgs || [])].map(shellArg).join(" ");
}

function isNumericStep(name: string): boolean {
  return /^\d+$/.test(name) && !name.startsWith("tmp_");
}

function listStepsInRunDir(runDir: string): number[] {
  if (!fs.existsSync(runDir)) return [];
  try {
    return fs
      .readdirSync(runDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && isNumericStep(e.name))
      .map((e) => parseInt(e.name, 10))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => b - a);
  } catch {
    return [];
  }
}

function backendFromRun(runDir: string): "jax" | "torch" | undefined {
  for (const step of listStepsInRunDir(runDir)) {
    const leaf = path.join(runDir, String(step));
    try {
      const names = new Set(fs.readdirSync(leaf));
      if (names.has("model.safetensors")) return "torch";
      if (names.has("params") || names.has("_CHECKPOINT_METADATA")) return "jax";
    } catch {}
  }
  return undefined;
}

function collectLocalRuns(root = CHECKPOINTS_ROOT): TrainExperimentInfo[] {
  const out: TrainExperimentInfo[] = [];
  if (!fs.existsSync(root)) return out;
  for (const configEnt of fs.readdirSync(root, { withFileTypes: true })) {
    if (!configEnt.isDirectory() || configEnt.name.startsWith(".")) continue;
    const configDir = path.join(root, configEnt.name);
    for (const expEnt of fs.readdirSync(configDir, { withFileTypes: true })) {
      if (!expEnt.isDirectory() || expEnt.name.startsWith(".")) continue;
      const runDir = path.join(configDir, expEnt.name);
      const steps = listStepsInRunDir(runDir);
      if (steps.length === 0) continue;
      const stat = fs.statSync(runDir);
      const runRelativePath = `${configEnt.name}/${expEnt.name}`;
      out.push({
        source: "local",
        configName: configEnt.name,
        expName: expEnt.name,
        runRelativePath,
        localRunPath: runDir,
        mtimeMs: stat.mtimeMs,
        steps,
        backendHint: backendFromRun(runDir),
      });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function listRemoteRunDirs(host: RemoteHost): Promise<Array<{ rel: string; mtimeMs: number }>> {
  const root = host.checkpointRoot || path.posix.join(host.repoRoot, "checkpoints");
  const script = `test -d ${shellArg(root)} || exit 0; find ${shellArg(root)} -mindepth 2 -maxdepth 2 -type d -printf '%P\\t%T@\\n'`;
  const { stdout } = await sshExec(host, script, 16 * 1024 * 1024);
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [rel, mtimeRaw] = line.split("\t");
      return { rel, mtimeMs: Math.round(parseFloat(mtimeRaw || "0") * 1000) };
    });
}

async function listRemoteSteps(host: RemoteHost, runRelativePath: string): Promise<number[]> {
  const root = host.checkpointRoot || path.posix.join(host.repoRoot, "checkpoints");
  const runDir = path.posix.join(root, runRelativePath);
  const script = `test -d ${shellArg(runDir)} || exit 0; find ${shellArg(runDir)} -mindepth 1 -maxdepth 1 -type d -printf '%f\\n'`;
  const { stdout } = await sshExec(host, script, 4 * 1024 * 1024);
  return stdout
    .trim()
    .split("\n")
    .filter((n) => isNumericStep(n.trim()))
    .map((n) => parseInt(n.trim(), 10))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => b - a);
}

export async function listTrainExperiments(configName?: string): Promise<TrainExperimentInfo[]> {
  let runs = collectLocalRuns().map((r) => ({ ...r, hostLabel: "Local" }));
  for (const host of listRemoteHosts()) {
    try {
      const dirs = await listRemoteRunDirs(host);
      for (const { rel, mtimeMs } of dirs) {
        const parts = rel.split("/");
        if (parts.length < 2) continue;
        const cfg = parts[0];
        const exp = parts[1];
        const steps = await listRemoteSteps(host, rel);
        if (steps.length === 0) continue;
        runs.push({
          source: "remote",
          hostId: host.id,
          hostLabel: host.label,
          configName: cfg,
          expName: exp,
          runRelativePath: rel,
          localRunPath: path.join(REPO_ROOT, "checkpoints", rel),
          mtimeMs,
          steps,
        });
      }
    } catch {
      continue;
    }
  }
  if (configName) runs = runs.filter((r) => r.configName === configName);
  return runs.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export async function ensureCheckpointRunOnLocal(
  source: "local" | "remote",
  runRelativePath: string,
  hostId?: string,
): Promise<string> {
  if (!runRelativePath || runRelativePath.includes("..") || runRelativePath.startsWith("/")) {
    throw new Error("invalid checkpoint run path");
  }
  const localRun = path.join(REPO_ROOT, "checkpoints", runRelativePath);
  if (source === "local") {
    if (!fs.existsSync(localRun)) throw new Error(`local checkpoint run not found: ${runRelativePath}`);
    return localRun;
  }
  const host = getRemoteHost(hostId);
  if (!host) throw new Error("unknown remote host for checkpoint");
  const remoteRoot = host.checkpointRoot || path.posix.join(host.repoRoot, "checkpoints");
  const remotePath = path.posix.join(remoteRoot, runRelativePath);
  fs.mkdirSync(path.dirname(localRun), { recursive: true });
  await execFileAsync(
    "rsync",
    ["-az", "-e", rsyncSsh(host), `${host.sshTarget}:${remotePath}/`, `${localRun}/`],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  return localRun;
}

export async function syncCheckpointRunToRemote(host: RemoteHost, runRelativePath: string): Promise<void> {
  if (!runRelativePath || runRelativePath.includes("..")) throw new Error("invalid checkpoint run path");
  const localRun = path.join(REPO_ROOT, "checkpoints", runRelativePath);
  if (!fs.existsSync(localRun)) throw new Error(`local checkpoint run not found: ${localRun}`);
  const remoteRoot = host.checkpointRoot || path.posix.join(host.repoRoot, "checkpoints");
  const remoteRun = path.posix.join(remoteRoot, runRelativePath);
  await prepareRemoteCheckpointDirForRsync(host, runRelativePath);
  await execFileAsync(
    "rsync",
    ["-az", "-e", rsyncSsh(host), `${localRun}/`, `${host.sshTarget}:${remoteRun}/`],
    { maxBuffer: 8 * 1024 * 1024 },
  );
}