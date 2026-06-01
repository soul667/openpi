import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DATA_DIR, HF_LEROBOT_HOST } from "./paths.js";
import { GpuInfo, GpuProcInfo, GpuSnapshot, RemoteHost } from "./types.js";

const execFileAsync = promisify(execFile);
const REMOTES_FILE = path.join(DATA_DIR, "remotes.json");

const DEFAULT_REMOTES: RemoteHost[] = [
  {
    id: "srv-117-238",
    label: "axgu@10.16.117.238",
    sshTarget: "axgu@10.16.117.238",
    repoRoot: "/data2/axgu/code/openpi",
    datasetRoot: "/data2/axgu/.cache/huggingface/lerobot",
    containerName: "openpi",
  },
];

function shellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function readRemotesFile(): RemoteHost[] {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(REMOTES_FILE)) {
    fs.writeFileSync(REMOTES_FILE, JSON.stringify(DEFAULT_REMOTES, null, 2));
    return DEFAULT_REMOTES;
  }
  try {
    return JSON.parse(fs.readFileSync(REMOTES_FILE, "utf8")) as RemoteHost[];
  } catch {
    return DEFAULT_REMOTES;
  }
}

export function listRemoteHosts(): RemoteHost[] {
  return readRemotesFile();
}

export function getRemoteHost(id?: string): RemoteHost | null {
  if (!id || id === "local") return null;
  return readRemotesFile().find((h) => h.id === id) ?? null;
}

export async function sshExec(host: RemoteHost, bashCmd: string, maxBuffer = 16 * 1024 * 1024): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host.sshTarget, `bash -lc ${shellArg(bashCmd)}`],
    { maxBuffer },
  );
  return { stdout, stderr };
}

export async function remoteDockerExec(host: RemoteHost, innerCmd: string, detached = false): Promise<void> {
  await sshExec(
    host,
    `docker exec ${detached ? "-d " : ""}${shellArg(host.containerName || "openpi")} bash -lc ${shellArg(innerCmd)}`,
  );
}

export async function remoteDockerPgrep(host: RemoteHost, pattern: string): Promise<number | null> {
  try {
    const { stdout } = await sshExec(host, `docker exec ${shellArg(host.containerName || "openpi")} pgrep -f ${shellArg(pattern)} | head -n1`);
    const pid = parseInt(stdout.trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

export async function remoteDockerGetPgid(host: RemoteHost, pid: number): Promise<number | null> {
  try {
    const { stdout } = await sshExec(host, `docker exec ${shellArg(host.containerName || "openpi")} ps -o pgid= -p ${pid} 2>/dev/null | tr -d ' '`);
    const pgid = parseInt(stdout.trim(), 10);
    return Number.isFinite(pgid) ? pgid : null;
  } catch {
    return null;
  }
}

export async function remoteDockerKillPgid(host: RemoteHost, pgid: number, signal: "TERM" | "KILL"): Promise<void> {
  await sshExec(host, `docker exec ${shellArg(host.containerName || "openpi")} kill -${signal} -${pgid} 2>/dev/null; exit 0`).catch(() => {});
}

export async function remoteDockerPkill(host: RemoteHost, pattern: string, signal9 = false): Promise<void> {
  const sig = signal9 ? "-9 " : "";
  await sshExec(host, `docker exec ${shellArg(host.containerName || "openpi")} pkill ${sig}-f ${shellArg(pattern)} 2>/dev/null; exit 0`).catch(() => {});
}

export async function remoteContainerRunning(host: RemoteHost): Promise<boolean> {
  try {
    const { stdout } = await sshExec(host, `docker inspect -f '{{.State.Running}}' ${shellArg(host.containerName || "openpi")}`);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

export function remoteLogFileFor(host: RemoteHost, jobId: string): string {
  return path.posix.join(host.repoRoot, "logs", `${jobId}.log`);
}

export async function remoteReadLogChunk(host: RemoteHost, logFile: string, fromByte: number): Promise<{ chunk: string; nextByte: number; eof: boolean }> {
  const script = `python3 - <<'PY'
import os, sys
p=${JSON.stringify(logFile)}
off=${Math.max(0, fromByte)}
if not os.path.exists(p):
    print('')
    sys.exit(0)
size=os.path.getsize(p)
with open(p, 'rb') as f:
    f.seek(min(off, size))
    sys.stdout.buffer.write(f.read(4*1024*1024))
PY`;
  const { stdout } = await sshExec(host, script, 8 * 1024 * 1024);
  return { chunk: stdout, nextByte: fromByte + Buffer.byteLength(stdout), eof: false };
}

export async function remoteAppendLog(host: RemoteHost, logFile: string, text: string): Promise<void> {
  await sshExec(host, `mkdir -p ${shellArg(path.posix.dirname(logFile))} && printf %s ${shellArg(text)} >> ${shellArg(logFile)}`);
}

export async function remoteParseExitCode(host: RemoteHost, logFile: string): Promise<number | null> {
  try {
    const { stdout } = await sshExec(host, `tail -c 4096 ${shellArg(logFile)} 2>/dev/null || true`);
    const restart = stdout.lastIndexOf("__AUTORESTART__:");
    const relevant = restart >= 0 ? stdout.slice(restart) : stdout;
    const matches = [...relevant.matchAll(/__EXIT__:(\d+)/g)];
    const last = matches.at(-1);
    return last ? parseInt(last[1], 10) : null;
  } catch {
    return null;
  }
}

export async function syncDatasetToRemote(host: RemoteHost, repoId?: string): Promise<void> {
  if (!repoId || !host.datasetRoot) return;
  const [user, dataset] = repoId.split("/");
  if (!user || !dataset) return;
  const localDir = path.join(HF_LEROBOT_HOST, user, dataset);
  if (!fs.existsSync(localDir)) throw new Error(`local dataset not found: ${localDir}`);
  const remoteParent = path.posix.join(host.datasetRoot, user);
  await sshExec(host, `mkdir -p ${shellArg(remoteParent)}`);
  await execFileAsync(
    "rsync",
    ["-az", `${localDir}/`, `${host.sshTarget}:${path.posix.join(remoteParent, dataset)}/`],
    { maxBuffer: 8 * 1024 * 1024 },
  );
}

function parseCsv(text: string): string[][] {
  return text.trim().split("\n").filter((l) => l.length > 0).map((l) => l.split(",").map((c) => c.trim()));
}

export async function getRemoteGpuSnapshot(host: RemoteHost): Promise<GpuSnapshot> {
  try {
    const { stdout } = await sshExec(
      host,
      "nvidia-smi --query-gpu=index,name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu --format=csv,noheader,nounits",
    );
    const gpus: GpuInfo[] = parseCsv(stdout).map((row) => ({
      index: parseInt(row[0], 10),
      name: row[1],
      memoryTotalMib: parseInt(row[2], 10),
      memoryUsedMib: parseInt(row[3], 10),
      memoryFreeMib: parseInt(row[4], 10),
      utilizationPct: parseInt(row[5], 10),
      temperatureC: parseInt(row[6], 10),
    }));
    let processes: GpuProcInfo[] = [];
    try {
      const { stdout: procOut } = await sshExec(host, "nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits");
      processes = parseCsv(procOut).map((row) => ({
        gpuIndex: -1,
        pid: parseInt(row[0], 10),
        processName: row[1],
        memoryUsedMib: parseInt(row[2], 10),
      }));
    } catch {}
    return { available: true, gpus, processes, at: Date.now() };
  } catch (e: unknown) {
    return { available: false, error: (e as Error).message, gpus: [], processes: [], at: Date.now() };
  }
}
