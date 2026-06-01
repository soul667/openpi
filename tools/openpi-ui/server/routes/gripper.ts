import path from "node:path";
import { FastifyInstance } from "fastify";
import { dockerExec } from "../lib/docker.js";

const REPO_ID_PARAM = /^[A-Za-z0-9_.\-]+$/;
const CONTAINER_LEROBOT = "/root/.cache/huggingface/lerobot";
const CONTAINER_SCRIPT = "/app/tools/openpi-ui/server/scripts/gripper_normalize.py";

interface GripperStatsResp {
  datasetDir: string;
  fileCount: number;
  dims: Record<string, number | null>;
  gripperIdx: number;
  stats: Record<
    string,
    {
      min: number;
      max: number;
      mean: number;
      std: number;
      median: number;
      count: number;
      unique_count: number;
      unique_preview: number[];
    }
  >;
}

interface ApplyResp {
  ok: boolean;
  datasetDir: string;
  backupPath: string | null;
  filesProcessed: number;
  filesChanged: number;
  gripperIdx: number;
  mode: string;
  params: Record<string, number>;
}

function shellArg(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export async function gripperRoutes(fastify: FastifyInstance) {
  fastify.get<{
    Params: { user: string; name: string };
    Querystring: { gripperIdx?: string };
  }>("/api/datasets/:user/:name/gripper-stats", async (req, reply) => {
    const { user, name } = req.params;
    if (!REPO_ID_PARAM.test(user) || !REPO_ID_PARAM.test(name)) {
      reply.code(400);
      return { error: "invalid repoId" };
    }
    const ds = path.posix.join(CONTAINER_LEROBOT, user, name);
    const idxFlag =
      req.query.gripperIdx !== undefined ? `--gripper-idx ${parseInt(req.query.gripperIdx, 10)}` : "";
    const cmd = `cd /app && uv run python ${CONTAINER_SCRIPT} stats --dataset-dir ${shellArg(ds)} ${idxFlag} 2>/dev/null`;
    try {
      const { stdout } = await dockerExec(cmd);
      const m = stdout.match(/\{[\s\S]*\}/);
      const json = m ? m[0] : stdout;
      const parsed = JSON.parse(json) as GripperStatsResp & { error?: string };
      if (parsed.error) {
        reply.code(404);
        return parsed;
      }
      return parsed;
    } catch (e: unknown) {
      reply.code(500);
      return { error: (e as Error).message };
    }
  });

  fastify.post<{
    Params: { user: string; name: string };
    Body: {
      mode: "threshold-binary" | "minmax-01" | "divide";
      params: Record<string, number>;
      gripperIdx?: number;
      backup?: boolean;
    };
  }>("/api/datasets/:user/:name/normalize-gripper", async (req, reply) => {
    const { user, name } = req.params;
    if (!REPO_ID_PARAM.test(user) || !REPO_ID_PARAM.test(name)) {
      reply.code(400);
      return { error: "invalid repoId" };
    }
    const body = req.body || ({} as never);
    if (!["threshold-binary", "minmax-01", "divide"].includes(body.mode)) {
      reply.code(400);
      return { error: "invalid mode" };
    }
    const ds = path.posix.join(CONTAINER_LEROBOT, user, name);
    const idxFlag = body.gripperIdx !== undefined ? `--gripper-idx ${body.gripperIdx}` : "";
    const backupFlag = body.backup === false ? "" : "--backup";
    const paramsJson = JSON.stringify(body.params || {});
    const cmd = `cd /app && uv run python ${CONTAINER_SCRIPT} apply --dataset-dir ${shellArg(ds)} ${idxFlag} --mode ${body.mode} --params ${shellArg(paramsJson)} ${backupFlag} 2>/dev/null`;
    try {
      const { stdout } = await dockerExec(cmd);
      const m = stdout.match(/\{[\s\S]*\}/);
      const json = m ? m[0] : stdout;
      const parsed = JSON.parse(json) as ApplyResp & { error?: string };
      if (parsed.error) {
        reply.code(500);
        return parsed;
      }
      return parsed;
    } catch (e: unknown) {
      reply.code(500);
      return { error: (e as Error).message };
    }
  });
}
