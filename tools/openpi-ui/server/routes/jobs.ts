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

if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

const REPO_ID_RE = /^[A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+$/;
const NAME_RE = /^[A-Za-z0-9_.\-]+$/;

function blockIfActive(): JobRecord | null {
  const active = jobsStore.getActive();
  return active || null;
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

function buildTrainCmd(jobId: string, req: TrainJobRequest, redact: boolean): string {
  const env: string[] = [];
  if (req.cudaVisibleDevices) env.push(`CUDA_VISIBLE_DEVICES=${req.cudaVisibleDevices}`);
  if (req.xlaMemFraction !== undefined) env.push(`XLA_PYTHON_CLIENT_MEM_FRACTION=${req.xlaMemFraction}`);
  if (req.wandbEnabled) {
    env.push(`WANDB_MODE=online`);
    if (req.wandbApiKey) env.push(`WANDB_API_KEY=${redact ? "***" : req.wandbApiKey}`);
  } else {
    env.push(`WANDB_MODE=disabled`);
  }
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
  ];
  const flags = joinFlags(cliFlags);
  const envStr = env.join(" ");
  const pre = (getPreCommand() || "").trim();
  const preStr = pre ? `${pre} && ` : "";
  const inner = `cd /app && ${preStr}mkdir -p logs && ${envStr} nohup uv run scripts/train.py ${req.configName} ${flags} > logs/${jobId}.log 2>&1; echo __EXIT__:$? >> logs/${jobId}.log`;
  return inner;
}

async function attachLifecycle(jobId: string) {
  const job = jobsStore.get(jobId);
  if (!job) return;
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
    if (!cur.pgid && cur.pid) {
      const pgid = await dockerGetPgid(cur.pid);
      if (pgid) jobsStore.update(jobId, { pgid });
    }
    const exitCode = parseExitCode(cur.logFile);
    if (exitCode !== null) {
      jobsStore.update(jobId, {
        status: exitCode === 0 ? "succeeded" : "failed",
        finishedAt: Date.now(),
        exitCode,
      });
      clearInterval(interval);
      return;
    }
    const pid = await dockerPgrep(`logs/${jobId}.log`);
    if (!pid) {
      const recheck = parseExitCode(cur.logFile);
      const status = recheck === 0 ? "succeeded" : "failed";
      jobsStore.update(jobId, { status, finishedAt: Date.now(), exitCode: recheck ?? null });
      clearInterval(interval);
    }
  }, 1500);
}

async function killJobHard(jobId: string, kind: "norm-stats" | "train", pgid?: number | null): Promise<{ stillAlive: number[] }> {
  const scriptName = kind === "train" ? "scripts/train.py" : "scripts/compute_norm_stats.py";
  if (pgid) {
    await dockerKillPgid(pgid, "TERM");
  }
  await dockerPkill(`logs/${jobId}.log`);
  await dockerPkill(scriptName);
  await new Promise((r) => setTimeout(r, 2000));
  let alive = await dockerPgrepAll(scriptName);
  if (pgid && alive.length) {
    await dockerKillPgid(pgid, "KILL");
  }
  if (alive.length) {
    await dockerPkill9(`logs/${jobId}.log`);
    await dockerPkill9(scriptName);
    await new Promise((r) => setTimeout(r, 1500));
    alive = await dockerPgrepAll(scriptName);
  }
  return { stillAlive: alive };
}

function parseExitCode(logFile: string): number | null {
  if (!fs.existsSync(logFile)) return null;
  const stat = fs.statSync(logFile);
  const fd = fs.openSync(logFile, "r");
  try {
    const len = Math.min(stat.size, 4096);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, Math.max(0, stat.size - len));
    const m = buf.toString("utf8").match(/__EXIT__:(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  } finally {
    fs.closeSync(fd);
  }
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
    const active = blockIfActive();
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
    const active = blockIfActive();
    if (active) {
      reply.code(409);
      return { error: "another job is active", activeJob: active };
    }
    if (!(await dockerContainerRunning())) {
      reply.code(503);
      return { error: "docker container is not running" };
    }
    const jobId = generateJobId(`train_${body.expName}`);
    const resolvedKey = body.wandbApiKey?.trim() || getWandbKey() || undefined;
    const resolvedBody: TrainJobRequest = { ...body, wandbApiKey: resolvedKey };
    const realCmd = buildTrainCmd(jobId, resolvedBody, false);
    const safeCmd = buildTrainCmd(jobId, resolvedBody, true);
    const job: JobRecord = {
      id: jobId,
      kind: "train",
      status: "queued",
      command: safeCmd,
      logFile: logFileFor(REPO_ROOT, jobId),
      containerName: process.env.OPENPI_UI_CONTAINER || "openpi-RcvkabOpenpi-1",
      configName: body.configName,
      expName: body.expName,
      repoId: body.repoId,
      createdAt: Date.now(),
      request: { ...body, wandbApiKey: resolvedKey ? "***" : undefined },
    };
    jobsStore.add(job);
    try {
      await dockerExecDetached(realCmd);
    } catch (e: unknown) {
      jobsStore.update(jobId, { status: "failed", finishedAt: Date.now(), exitCode: -1 });
      reply.code(500);
      return { error: (e as Error).message };
    }
    attachLifecycle(jobId);
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
    let pgid = job.pgid ?? null;
    if (!pgid && job.pid) {
      pgid = await dockerGetPgid(job.pid);
    }
    const { stillAlive } = await killJobHard(id, job.kind, pgid);
    const exitCode = parseExitCode(job.logFile);
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
        const tailer = new LogTailer(job.logFile, 0);
        tailer.on("data", (chunk: string) => {
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ type: "data", data: chunk }));
          }
        });
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
            setTimeout(() => {
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
        tailer.start().catch(() => {});
        socket.on("close", () => {
          tailer.close();
          jobsStore.off("change", onChange);
        });
      },
    );
  });
}
