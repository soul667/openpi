import { FastifyInstance } from "fastify";
import { dockerExec } from "../lib/docker.js";

const REPO_ID_PARAM = /^[A-Za-z0-9_.\-]+$/;
const SAFE_PATH = /^\/app\/assets\/[A-Za-z0-9_.\-/]+\/norm_stats\.json$/;
const SCRIPT = "/app/tools/openpi-ui/server/scripts/norm_stats_edit.py";

function shellArg(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

interface NormStatsListResp {
  user: string;
  dataset: string;
  files: Array<{ configName: string; path: string; mtimeMs: number; sizeBytes: number }>;
  error?: string;
}

interface NormStatsEntry {
  mean: number[];
  std: number[];
  q01: number[] | null;
  q99: number[] | null;
}

interface NormStatsDimDiag {
  dim: number;
  std?: number;
  stdNearZero?: boolean;
  q01?: number;
  q99?: number;
  span?: number;
  spanNearZero?: boolean;
}

interface NormStatsGetResp {
  path: string;
  mtimeMs: number;
  stats: Record<string, NormStatsEntry>;
  diagnostics: Record<string, NormStatsDimDiag[]>;
  error?: string;
}

type DimOverrides = Record<string, number>;
type FieldOverrides = Partial<Record<"mean" | "std" | "q01" | "q99", { dims: DimOverrides }>>;
type Overrides = Record<string, FieldOverrides>;

interface NormStatsPatchResp {
  ok: boolean;
  path: string;
  backupPath: string | null;
  changedDims: Array<{ key: string; field: string; dim: number; value: number }>;
  error?: string;
}

async function runScript<T>(cmd: string): Promise<T> {
  const { stdout } = await dockerExec(cmd);
  const start = stdout.indexOf("{");
  const json = start >= 0 ? stdout.slice(start) : stdout;
  return JSON.parse(json) as T;
}

export async function normStatsRoutes(fastify: FastifyInstance) {
  fastify.get<{
    Params: { user: string; name: string };
  }>("/api/datasets/:user/:name/norm-stats", async (req, reply) => {
    const { user, name } = req.params;
    if (!REPO_ID_PARAM.test(user) || !REPO_ID_PARAM.test(name)) {
      reply.code(400);
      return { error: "invalid repoId" };
    }
    const cmd = `python3 ${SCRIPT} list --user ${shellArg(user)} --dataset ${shellArg(name)}`;
    try {
      const parsed = await runScript<NormStatsListResp>(cmd);
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

  fastify.get<{
    Querystring: { path?: string };
  }>("/api/norm-stats", async (req, reply) => {
    const p = req.query.path;
    if (!p || !SAFE_PATH.test(p)) {
      reply.code(400);
      return { error: "invalid or missing path" };
    }
    const cmd = `python3 ${SCRIPT} get --path ${shellArg(p)}`;
    try {
      const parsed = await runScript<NormStatsGetResp>(cmd);
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

  fastify.patch<{
    Body: {
      path: string;
      overrides: Overrides;
      backup?: boolean;
    };
  }>("/api/norm-stats", async (req, reply) => {
    const body = req.body || ({} as never);
    if (!body.path || !SAFE_PATH.test(body.path)) {
      reply.code(400);
      return { error: "invalid or missing path" };
    }
    if (!body.overrides || typeof body.overrides !== "object") {
      reply.code(400);
      return { error: "missing overrides" };
    }
    const overridesJson = JSON.stringify(body.overrides);
    const backupFlag = body.backup === false ? "" : "--backup";
    const cmd = `python3 ${SCRIPT} patch --path ${shellArg(body.path)} --overrides ${shellArg(
      overridesJson,
    )} ${backupFlag}`;
    try {
      const parsed = await runScript<NormStatsPatchResp>(cmd);
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

  const NAME_RE = /^[A-Za-z0-9_.\-]+$/;
  fastify.get<{ Params: { configName: string } }>(
    "/api/configs/:configName/asset-norms",
    async (req, reply) => {
      const cfg = req.params.configName;
      if (!NAME_RE.test(cfg)) {
        reply.code(400);
        return { error: "invalid configName" };
      }
      const cmd = `python3 ${SCRIPT} list-config-assets --config ${shellArg(cfg)}`;
      try {
        const parsed = await runScript<{ configName: string; assets: Array<{ assetId: string; path: string; mtimeMs: number; sizeBytes: number }> }>(cmd);
        return parsed;
      } catch (e: unknown) {
        reply.code(500);
        return { error: (e as Error).message };
      }
    }
  );
}
