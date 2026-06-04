import fs from "node:fs";
import path from "node:path";
import { FastifyInstance } from "fastify";
import { LOGS_DIR, REPO_ROOT } from "../lib/paths.js";
import {
  generateJobId,
  jobsStore,
  logFileFor,
} from "../lib/jobs-store.js";
import {
  dockerContainerRunning,
  dockerExecDetached,
  dockerGetPgid,
  dockerKillPgid,
  dockerPgrep,
  dockerPgrepAll,
  dockerPkill,
  dockerPkill9,
} from "../lib/docker.js";
import { joinFlags } from "../lib/shell.js";
import { LogTailer, readLogChunk } from "../lib/log-tailer.js";
import { getPreCommand, getWandbKey } from "../lib/secrets-store.js";
import { JobRecord, NormStatsJobRequest, TrainJobRequest } from "../lib/types.js";
import {
  getRemoteHost,
  remoteAppendLog,
  remoteContainerRunning,
  remoteDockerExec,
  remoteDockerGetPgid,
  remoteDockerKillPgid,
  remoteDockerPgrep,
  remoteDockerPkill,
  remoteLogFileFor,
  remoteParseExitCode,
  remoteReadLogChunk,
  syncDatasetToRemote,
  syncTrainingAssetsToRemote,
} from "../lib/remotes.js";

if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

const REPO_ID_RE = /^[A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+$/;
const NAME_RE = /^[A-Za-z0-9_.\-]+$/;
const NAN_TOKEN_RE = /(^|[^A-Za-z0-9_])nan([^A-Za-z0-9_]|$)/i;
const MAX_NAN_RESTARTS = 3;

function parseGpuList(cudaVisibleDevices: string | undefined): Set<number> | null {
  if (!cudaVisibleDevices) return null;
  const gpus = new Set<number>();
  for (const part of cudaVisibleDevices.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const num = parseInt(trimmed, 10);
    if (!Number.isNaN(num)) {
      gpus.add(num);
    }
  }
  return gpus.size > 0 ? gpus : null;
}

function gpusOverlap(newGpus: Set<number> | null, existingGpus: Set<number> | null): boolean {
  // If either job doesn't specify GPUs, assume it uses all GPUs (conservative)
  if (!newGpus || !existingGpus) return true;
  for (const gpu of newGpus) {
    if (existingGpus.has(gpu)) return true;
  }
  return false;
}

function blockIfActive(targetHostId = "local", newCudaVisibleDevices?: string): JobRecord | null {
  const activeJobs = jobsStore.getAllActiveForTarget(targetHostId);
  if (activeJobs.length === 0) return null;

  const newGpus = parseGpuList(newCudaVisibleDevices);

  for (const activeJob of activeJobs) {
    const activeRequest = activeJob.request as TrainJobRequest;
    const activeGpus = parseGpuList(activeRequest.cudaVisibleDevices);
    if (gpusOverlap(newGpus, activeGpus)) {
      return activeJob;
    }
  }

  return null;
}

function buildNormCmd(jobId: string, req: NormStatsJobRequest): string {
  const flags = joinFlags([
    `--config-name=${req.configName}`,
    req.repoId ? `--repo-id=${req.repoId}` : null,
    req.maxFrames ? `--max-frames=${req.maxFrames}` : null,
  ]);
  const pre = (getPreCommand() || "").trim();
  const preStr = pre ? `${pre} && ` : "";
  const inner = `cd /app && ${preStr}mkdir -p logs && GIT_LFS_SKIP_SMUDGE=1 nohup uv run scripts/compute_norm_stats.py ${flags} > logs/${jobId}.log 2>&1; echo __EXIT__:$? >> logs/${jobId}.log`;
  return inner;
}

function replaceNormForRun(configName: string, repoId: string | undefined, assetId: string | undefined): { src: string; dst: string; backup: string | null } | null {
  if (!configName || !repoId || !assetId) return null;
  const src = path.join(REPO_ROOT, "assets", configName, assetId, "norm_stats.json");
  if (!fs.existsSync(src)) return null;
  const segs = repoId.split("/").filter((s) => s.length > 0);
  const dstDir = path.join(REPO_ROOT, "assets", configName, ...segs);
  const dst = path.join(dstDir, "norm_stats.json");
  if (src === dst) return null;
  try {
    fs.mkdirSync(dstDir, { recursive: true });
    let backup: string | null = null;
    if (fs.existsSync(dst)) {
      backup = dst + ".bak." + Date.now();
      fs.copyFileSync(dst, backup);
    }
    fs.copyFileSync(src, dst);
    return { src, dst, backup };
  } catch (e) {
    console.error("norm replace failed", e);
    return null;
  }
}

function buildTrainCmd(jobId: string, req: TrainJobRequest, redact: boolean, appendLog = false): string {
  const isTorch = !!req.usePytorch;
  const env: string[] = [];
  if (req.cudaVisibleDevices) env.push(`CUDA_VISIBLE_DEVICES=${req.cudaVisibleDevices}`);
  if (!isTorch && req.xlaMemFraction !== undefined) env.push(`XLA_PYTHON_CLIENT_MEM_FRACTION=${req.xlaMemFraction}`);
  if (req.wandbEnabled) {
    env.push(`WANDB_MODE=online`);
    if (req.wandbApiKey) env.push(`WANDB_API_KEY=${redact ? "***" : req.wandbApiKey}`);
  } else {
    env.push(`WANDB_MODE=disabled`);
  }
  const pre = (getPreCommand() || "").trim();
  const preStr = pre ? `${pre} && ` : "";
  const redirect = appendLog ? ">>" : ">";
  const envStr = env.join(" ");

  if (isTorch) {
    const nproc = req.cudaVisibleDevices ? req.cudaVisibleDevices.split(",").filter(Boolean).length : 1;
    const cliFlags: Array<string | null> = [
      `--exp-name=${req.expName}`,
      req.repoId ? `--data.repo-id=${req.repoId}` : null,
      req.numTrainSteps !== undefined ? `--num-train-steps=${req.numTrainSteps}` : null,
      req.seed !== undefined ? `--seed=${req.seed}` : null,
      req.batchSize !== undefined ? `--batch-size=${req.batchSize}` : null,
      req.logInterval !== undefined ? `--log-interval=${req.logInterval}` : null,
      req.saveInterval !== undefined ? `--save-interval=${req.saveInterval}` : null,
      req.keepPeriod !== undefined ? `--keep-period=${req.keepPeriod}` : null,
      req.overwrite !== undefined ? (req.overwrite ? "--overwrite" : "--no-overwrite") : null,
      req.resume ? "--resume" : null,
      req.wandbEnabled !== undefined ? (req.wandbEnabled ? "--wandb-enabled" : "--no-wandb-enabled") : null,
      req.assetId ? `--data.assets.asset-id=${req.assetId}` : null,
      req.pytorchTrainingPrecision ? `--pytorch-training-precision=${req.pytorchTrainingPrecision}` : null,
    ];
    const flags = joinFlags(cliFlags);
    const torchPrefix = `uv run torchrun --standalone --nnodes=1 --nproc_per_node=${nproc} `;
    const inner = `cd /app && ${preStr}mkdir -p logs && ${envStr} nohup ${torchPrefix}scripts/train_pytorch.py ${req.configName} ${flags} ${redirect} logs/${jobId}.log 2>&1; echo __EXIT__:$? >> logs/${jobId}.log`;
    return inner;
  } else {
    const cliFlags: Array<string | null> = [
      `--exp-name=${req.expName}`,
      req.repoId ? `--data.repo-id=${req.repoId}` : null,
      req.numTrainSteps !== undefined ? `--num-train-steps=${req.numTrainSteps}` : null,
      req.seed !== undefined ? `--seed=${req.seed}` : null,
      req.batchSize !== undefined ? `--batch-size=${req.batchSize}` : null,
      req.logInterval !== undefined ? `--log-interval=${req.logInterval}` : null,
      req.saveInterval !== undefined ? `--save-interval=${req.saveInterval}` : null,
      req.keepPeriod !== undefined ? `--keep-period=${req.keepPeriod}` : null,
      req.overwrite !== undefined ? (req.overwrite ? "--overwrite" : "--no-overwrite") : null,
      req.resume ? "--resume" : null,
      req.wandbEnabled !== undefined ? (req.wandbEnabled ? "--wandb-enabled" : "--no-wandb-enabled") : null,
      req.assetId ? `--data.assets.asset-id=${req.assetId}` : null,
    ];
    const flags = joinFlags(cliFlags);
    const inner = `cd /app && ${preStr}mkdir -p logs && ${envStr} nohup uv run scripts/train.py ${req.configName} ${flags} ${redirect} logs/${jobId}.log 2>&1; echo __EXIT__:$? >> logs/${jobId}.log`;
    return inner;
  }
}

async function attachLifecycle(jobId: string, restartRequest?: TrainJobRequest) {
  const job = jobsStore.get(jobId);
  if (!job) return;
  let nanScanOffset = 0;
  let nanCarry = "";
  setTimeout(async () => {
    if (jobsStore.get(jobId)?.status !== "queued") return;
    const pid = await dockerPgrep(`logs/${jobId}.log`);
    if (pid) {
      const pgid = await dockerGetPgid(pid);
      jobsStore.update(jobId, { status: "running", startedAt: Date.now(), pid, pgid });
    } else {
      const exitCode = parseExitCode(job.logFile);
      jobsStore.update(jobId, {
        status: exitCode === 0 ? "succeeded" : "failed",
        finishedAt: Date.now(),
        exitCode: exitCode ?? null,
      });
    }
  }, 1500);

  const interval = setInterval(async () => {
    const cur = jobsStore.get(jobId);
    if (!cur) {
      clearInterval(interval);
      return;
    }
    if (cur.status === "succeeded" || cur.status === "failed" || cur.status === "killed") {
      clearInterval(interval);
      return;
    }
    const remoteHost = getRemoteHost(cur.targetHostId);
    const activeLogFile = remoteHost ? cur.remoteLogFile || cur.logFile : cur.logFile;
    if (!cur.pgid && cur.pid) {
      const pgid = remoteHost ? await remoteDockerGetPgid(remoteHost, cur.pid) : await dockerGetPgid(cur.pid);
      if (pgid) jobsStore.update(jobId, { pgid });
    }
    if (cur.kind === "train" && restartRequest) {
      const nan = remoteHost
        ? await readNewRemoteNanMatch(remoteHost, activeLogFile, nanScanOffset, nanCarry)
        : readNewNanMatch(activeLogFile, nanScanOffset, nanCarry);
      nanScanOffset = nan.nextOffset;
      nanCarry = nan.carry;
      if (nan.found) {
        const restartCount = cur.autoRestartCount ?? 0;
        await appendJobLog(remoteHost, activeLogFile, `\n__NAN_DETECTED__: auto restart requested (${restartCount + 1}/${MAX_NAN_RESTARTS})\n`);
        let pgid = cur.pgid ?? null;
        if (!pgid && cur.pid) pgid = remoteHost ? await remoteDockerGetPgid(remoteHost, cur.pid) : await dockerGetPgid(cur.pid);
        if (remoteHost) await killRemoteJobHard(jobId, pgid);
        else await killJobHard(jobId, "train", pgid);
        if (restartCount >= MAX_NAN_RESTARTS) {
          await appendJobLog(remoteHost, activeLogFile, `__NAN_AUTORESTART_LIMIT__: ${MAX_NAN_RESTARTS}\n`);
          jobsStore.update(jobId, {
            status: "failed",
            finishedAt: Date.now(),
            exitCode: null,
            autoRestartCount: restartCount,
            autoRestartReason: "nan",
            pid: null,
            pgid: null,
          });
          clearInterval(interval);
          return;
        }
        const resumeReq: TrainJobRequest = { ...restartRequest, resume: true, overwrite: false };
        const restartCmd = buildTrainCmd(jobId, resumeReq, false, true);
        await appendJobLog(remoteHost, activeLogFile, `__AUTORESTART__: nan resume ${restartCount + 1}\n`);
        const restartScanOffset = remoteHost ? nanScanOffset : fs.existsSync(activeLogFile) ? fs.statSync(activeLogFile).size : 0;
        jobsStore.update(jobId, {
          status: "queued",
          pid: null,
          pgid: null,
          autoRestartCount: restartCount + 1,
          autoRestartReason: "nan",
        });
        if (remoteHost) await remoteDockerExec(remoteHost, restartCmd, true);
        else await dockerExecDetached(restartCmd);
        nanScanOffset = restartScanOffset;
        nanCarry = "";
        return;
      }
    }
    const exitCode = remoteHost ? await remoteParseExitCode(remoteHost, activeLogFile) : parseExitCode(activeLogFile);
    if (exitCode !== null) {
      jobsStore.update(jobId, {
        status: exitCode === 0 ? "succeeded" : "failed",
        finishedAt: Date.now(),
        exitCode,
      });
      clearInterval(interval);
      return;
    }
    const pid = remoteHost ? await remoteDockerPgrep(remoteHost, `logs/${jobId}.log`) : await dockerPgrep(`logs/${jobId}.log`);
    if (pid) {
      const pgid = remoteHost ? await remoteDockerGetPgid(remoteHost, pid) : await dockerGetPgid(pid);
      jobsStore.update(jobId, {
        status: "running",
        startedAt: cur.startedAt ?? Date.now(),
        pid,
        pgid: pgid ?? cur.pgid ?? null,
      });
    } else {
      const recheck = remoteHost ? await remoteParseExitCode(remoteHost, activeLogFile) : parseExitCode(activeLogFile);
      const status = recheck === 0 ? "succeeded" : "failed";
      jobsStore.update(jobId, { status, finishedAt: Date.now(), exitCode: recheck ?? null });
      clearInterval(interval);
    }
  }, 1500);
}

async function killJobHard(jobId: string, kind: "norm-stats" | "train", pgid?: number | null): Promise<{ stillAlive: number[] }> {
  const scriptNames = kind === "train" ? ["scripts/train.py", "scripts/train_pytorch.py"] : ["scripts/compute_norm_stats.py"];
  if (pgid) {
    await dockerKillPgid(pgid, "TERM");
  }
  await dockerPkill(`logs/${jobId}.log`);
  for (const sn of scriptNames) await dockerPkill(sn);
  await new Promise((r) => setTimeout(r, 2000));
  let alive: number[] = [];
  for (const sn of scriptNames) alive = alive.concat(await dockerPgrepAll(sn));
  if (pgid && alive.length) {
    await dockerKillPgid(pgid, "KILL");
  }
  if (alive.length) {
    await dockerPkill9(`logs/${jobId}.log`);
    for (const sn of scriptNames) await dockerPkill9(sn);
    await new Promise((r) => setTimeout(r, 1500));
    alive = [];
    for (const sn of scriptNames) alive = alive.concat(await dockerPgrepAll(sn));
  }
  return { stillAlive: alive };
}

async function killRemoteJobHard(jobId: string, pgid?: number | null): Promise<void> {
  const job = jobsStore.get(jobId);
  const host = getRemoteHost(job?.targetHostId);
  if (!host) return;
  if (pgid) await remoteDockerKillPgid(host, pgid, "TERM");
  await remoteDockerPkill(host, `logs/${jobId}.log`);
  await remoteDockerPkill(host, "scripts/train.py");
  await remoteDockerPkill(host, "scripts/train_pytorch.py");
  await remoteDockerPkill(host, "scripts/train.py", true);
  await remoteDockerPkill(host, "scripts/train_pytorch.py", true);
}

function parseExitCode(logFile: string): number | null {
  if (!fs.existsSync(logFile)) return null;
  const stat = fs.statSync(logFile);
  const fd = fs.openSync(logFile, "r");
  try {
    const len = Math.min(stat.size, 4096);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, Math.max(0, stat.size - len));
    const tail = buf.toString("utf8");
    const restart = tail.lastIndexOf("__AUTORESTART__:");
    const relevant = restart >= 0 ? tail.slice(restart) : tail;
    const matches = [...relevant.matchAll(/__EXIT__:(\d+)/g)];
    const last = matches.at(-1);
    return last ? parseInt(last[1], 10) : null;
  } finally {
    fs.closeSync(fd);
  }
}

function readNewNanMatch(logFile: string, fromOffset: number, carry: string): { found: boolean; nextOffset: number; carry: string } {
  if (!fs.existsSync(logFile)) return { found: false, nextOffset: 0, carry: "" };
  const stat = fs.statSync(logFile);
  const start = Math.min(fromOffset, stat.size);
  if (start >= stat.size) return { found: false, nextOffset: stat.size, carry };
  const len = Math.min(stat.size - start, 1024 * 1024);
  const fd = fs.openSync(logFile, "r");
  try {
    const buf = Buffer.alloc(len);
    const read = fs.readSync(fd, buf, 0, len, start);
    const chunk = buf.subarray(0, read).toString("utf8");
    const text = carry + chunk;
    return {
      found: NAN_TOKEN_RE.test(text),
      nextOffset: start + read,
      carry: text.slice(-16),
    };
  } finally {
    fs.closeSync(fd);
  }
}

async function readNewRemoteNanMatch(host: NonNullable<ReturnType<typeof getRemoteHost>>, logFile: string, fromOffset: number, carry: string): Promise<{ found: boolean; nextOffset: number; carry: string }> {
  const chunk = await remoteReadLogChunk(host, logFile, fromOffset);
  const text = carry + chunk.chunk;
  return {
    found: NAN_TOKEN_RE.test(text),
    nextOffset: chunk.nextByte,
    carry: text.slice(-16),
  };
}

async function appendJobLog(host: ReturnType<typeof getRemoteHost>, logFile: string, text: string): Promise<void> {
  if (host) await remoteAppendLog(host, logFile, text);
  else await fs.promises.appendFile(logFile, text);
}

export async function jobsRoutes(fastify: FastifyInstance) {
  fastify.get("/api/jobs", async () => jobsStore.list());

  fastify.post<{ Body: NormStatsJobRequest }>("/api/jobs/norm-stats", async (req, reply) => {
    const body = req.body || ({} as NormStatsJobRequest);
    if (!body.configName || !NAME_RE.test(body.configName)) {
      reply.code(400);
      return { error: "invalid configName" };
    }
    if (body.repoId && !REPO_ID_RE.test(body.repoId)) {
      reply.code(400);
      return { error: "invalid repoId, expect user/dataset" };
    }
    const active = blockIfActive("local");
    if (active) {
      reply.code(409);
      return { error: "another job is active", activeJob: active };
    }
    if (!(await dockerContainerRunning())) {
      reply.code(503);
      return { error: "docker container is not running" };
    }
    const jobId = generateJobId(`norm_${body.configName}`);
    const inner = buildNormCmd(jobId, body);
    const job: JobRecord = {
      id: jobId,
      kind: "norm-stats",
      status: "queued",
      command: inner,
      logFile: logFileFor(REPO_ROOT, jobId),
      containerName: process.env.OPENPI_UI_CONTAINER || "openpi-RcvkabOpenpi-1",
      configName: body.configName,
      repoId: body.repoId,
      createdAt: Date.now(),
      request: body,
    };
    jobsStore.add(job);
    try {
      await dockerExecDetached(inner);
    } catch (e: unknown) {
      jobsStore.update(jobId, { status: "failed", finishedAt: Date.now(), exitCode: -1 });
      reply.code(500);
      return { error: (e as Error).message };
    }
    attachLifecycle(jobId);
    return jobsStore.get(jobId);
  });

  fastify.post<{ Body: TrainJobRequest }>("/api/jobs/train", async (req, reply) => {
    const body = req.body || ({} as TrainJobRequest);
    if (!body.configName || !NAME_RE.test(body.configName)) {
      reply.code(400);
      return { error: "invalid configName" };
    }
    if (!body.expName || !NAME_RE.test(body.expName)) {
      reply.code(400);
      return { error: "invalid expName" };
    }
    if (body.repoId && !REPO_ID_RE.test(body.repoId)) {
      reply.code(400);
      return { error: "invalid repoId" };
    }
    const remoteHost = getRemoteHost(body.targetHostId);
    if (body.targetHostId && body.targetHostId !== "local" && !remoteHost) {
      reply.code(400);
      return { error: "unknown remote host" };
    }
    const active = blockIfActive(body.targetHostId || "local", body.cudaVisibleDevices);
    if (active) {
      reply.code(409);
      return { error: "another job is active", activeJob: active };
    }

    const replaceInfo = replaceNormForRun(body.configName, body.repoId, body.assetId);

    let containerRunning = false;
    try {
      if (remoteHost && body.syncDataset !== false) {
        await syncDatasetToRemote(remoteHost, body.repoId);
        await syncTrainingAssetsToRemote(remoteHost, body.configName);
      }
      containerRunning = remoteHost ? await remoteContainerRunning(remoteHost) : await dockerContainerRunning();
    } catch (e: unknown) {
      reply.code(500);
      return { error: `remote setup failed: ${(e as Error).message}` };
    }
    if (!containerRunning) {
      reply.code(503);
      return { error: remoteHost ? `remote docker container is not running: ${remoteHost.label}` : "docker container is not running" };
    }
    const jobId = generateJobId(`train_${body.expName}`);
    const resolvedKey = body.wandbApiKey?.trim() || getWandbKey() || undefined;
    if (body.wandbEnabled && !resolvedKey) {
      reply.code(400);
      return { error: "wandb is enabled but no API key is saved; set the key in the WandB card or disable wandb" };
    }
    const resolvedBody: TrainJobRequest = { ...body, wandbApiKey: resolvedKey };
    const realCmd = buildTrainCmd(jobId, resolvedBody, false);
    const safeCmd = buildTrainCmd(jobId, resolvedBody, true);
    const remoteLogFile = remoteHost ? remoteLogFileFor(remoteHost, jobId) : undefined;
    const job: JobRecord = {
      id: jobId,
      kind: "train",
      status: "queued",
      command: safeCmd,
      logFile: remoteHost && remoteLogFile ? `${remoteHost.sshTarget}:${remoteLogFile}` : logFileFor(REPO_ROOT, jobId),
      remoteLogFile,
      containerName: remoteHost?.containerName || process.env.OPENPI_UI_CONTAINER || "openpi-RcvkabOpenpi-1",
      configName: body.configName,
      expName: body.expName,
      repoId: body.repoId,
      assetId: body.assetId,
      targetHostId: body.targetHostId || "local",
      targetLabel: remoteHost?.label || "Local",
      createdAt: Date.now(),
      request: { ...body, wandbApiKey: resolvedKey ? "***" : undefined },
    };
    jobsStore.add(job);
    try {
      if (remoteHost) await remoteDockerExec(remoteHost, realCmd, true);
      else await dockerExecDetached(realCmd);
    } catch (e: unknown) {
      jobsStore.update(jobId, { status: "failed", finishedAt: Date.now(), exitCode: -1 });
      reply.code(500);
      return { error: (e as Error).message };
    }
    attachLifecycle(jobId, resolvedBody);
    return jobsStore.get(jobId);
  });

  fastify.post<{ Params: { id: string } }>("/api/jobs/:id/kill", async (req, reply) => {
    const { id } = req.params;
    const job = jobsStore.get(id);
    if (!job) {
      reply.code(404);
      return { error: "no such job" };
    }
    if (job.status === "succeeded" || job.status === "failed" || job.status === "killed") {
      return job;
    }
    const remoteHost = getRemoteHost(job.targetHostId);
    let pgid = job.pgid ?? null;
    if (!pgid && job.pid) {
      pgid = remoteHost ? await remoteDockerGetPgid(remoteHost, job.pid) : await dockerGetPgid(job.pid);
    }
    const stillAlive: number[] = [];
    if (remoteHost) await killRemoteJobHard(id, pgid);
    else stillAlive.push(...(await killJobHard(id, job.kind, pgid)).stillAlive);
    const exitCode = remoteHost ? await remoteParseExitCode(remoteHost, job.remoteLogFile || job.logFile) : parseExitCode(job.logFile);
    const updated = jobsStore.update(id, {
      status: "killed",
      finishedAt: Date.now(),
      exitCode: exitCode ?? null,
      pgid,
    });
    if (stillAlive.length > 0) {
      reply.code(202);
      return { ...updated, warning: `still alive: ${stillAlive.join(",")}` };
    }
    return updated;
  });

  fastify.get<{ Params: { id: string }; Querystring: { from?: string } }>(
    "/api/jobs/:id/log",
    async (req, reply) => {
      const job = jobsStore.get(req.params.id);
      if (!job) {
        reply.code(404);
        return { error: "no such job" };
      }
      const from = parseInt(req.query.from || "0", 10) || 0;
      const remoteHost = getRemoteHost(job.targetHostId);
      if (remoteHost) return remoteReadLogChunk(remoteHost, job.remoteLogFile || job.logFile, from);
      return readLogChunk(job.logFile, from);
    },
  );

  fastify.register(async function wsScope(scoped) {
    scoped.get<{ Params: { id: string } }>(
      "/ws/jobs/:id/log",
      { websocket: true },
      (socket, req) => {
        const id = (req.params as { id: string }).id;
        const job = jobsStore.get(id);
        if (!job) {
          socket.send(JSON.stringify({ type: "status", status: "failed", error: "no such job" }));
          socket.close();
          return;
        }
        const remoteHost = getRemoteHost(job.targetHostId);
        const tailer = remoteHost ? null : new LogTailer(job.logFile, 0);
        let remoteOffset = 0;
        let remoteTimer: NodeJS.Timeout | null = null;
        const pollRemoteLog = async () => {
          if (!remoteHost) return;
          try {
            const chunk = await remoteReadLogChunk(remoteHost, job.remoteLogFile || job.logFile, remoteOffset);
            remoteOffset = chunk.nextByte;
            if (chunk.chunk && socket.readyState === socket.OPEN) {
              socket.send(JSON.stringify({ type: "data", data: chunk.chunk }));
            }
          } catch {}
        };
        if (tailer) {
          tailer.on("data", (chunk: string) => {
            if (socket.readyState === socket.OPEN) {
              socket.send(JSON.stringify({ type: "data", data: chunk }));
            }
          });
        } else if (remoteHost) {
          pollRemoteLog().catch(() => {});
          remoteTimer = setInterval(() => pollRemoteLog().catch(() => {}), 1000);
        }
        const onChange = (changed: JobRecord) => {
          if (changed.id !== id) return;
          if (socket.readyState === socket.OPEN) {
            socket.send(
              JSON.stringify({ type: "status", status: changed.status, exitCode: changed.exitCode }),
            );
          }
          if (
            changed.status === "succeeded" ||
            changed.status === "failed" ||
            changed.status === "killed"
          ) {
            setTimeout(async () => {
              await pollRemoteLog();
              if (socket.readyState === socket.OPEN) {
                socket.send(JSON.stringify({ type: "end" }));
                socket.close();
              }
            }, 800);
          }
        };
        jobsStore.on("change", onChange);
        socket.send(
          JSON.stringify({ type: "status", status: job.status, exitCode: job.exitCode }),
        );
        tailer?.start().catch(() => {});
        socket.on("close", () => {
          tailer?.close();
          if (remoteTimer) clearInterval(remoteTimer);
          jobsStore.off("change", onChange);
        });
      },
    );
  });
}
