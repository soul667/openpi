import { FastifyInstance } from "fastify";
import { dockerExec } from "../lib/docker.js";
import { scanDatasets, writeTasks } from "../lib/dataset-scanner.js";
import { DatasetMergeRequest, DatasetMergeResult } from "../lib/types.js";

const REPO_ID_RE = /^[A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+$/;
const CONTAINER_SCRIPT = "/app/tools/openpi-ui/server/scripts/merge_lerobot_datasets.py";

function shellArg(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function isValidRepoId(repoId: string): boolean {
  if (!REPO_ID_RE.test(repoId)) return false;
  return !repoId.split("/").some((part) => part === "." || part === "..");
}

async function runMergeScript(body: DatasetMergeRequest): Promise<DatasetMergeResult & { error?: string }> {
  const sources = body.sourceRepoIds.map(shellArg).join(" ");
  const overwriteFlag = body.overwrite ? " --overwrite" : "";
  const cmd = `cd /app && (uv run python ${CONTAINER_SCRIPT} --sources ${sources} --target-repo-id ${shellArg(body.targetRepoId)}${overwriteFlag} 2>&1 || true)`;
  const { stdout } = await dockerExec(cmd);
  const start = stdout.indexOf("{");
  const json = start >= 0 ? stdout.slice(start) : stdout;
  return JSON.parse(json) as DatasetMergeResult & { error?: string };
}

export async function datasetsRoutes(fastify: FastifyInstance) {
  fastify.get("/api/datasets", async () => scanDatasets());

  fastify.post<{ Body: DatasetMergeRequest }>("/api/datasets/merge", async (req, reply) => {
    const body = req.body || ({} as DatasetMergeRequest);
    if (!Array.isArray(body.sourceRepoIds) || body.sourceRepoIds.length < 2) {
      reply.code(400);
      return { error: "sourceRepoIds must include at least two repoIds" };
    }
    if (!body.sourceRepoIds.every((repoId) => typeof repoId === "string" && isValidRepoId(repoId))) {
      reply.code(400);
      return { error: "invalid source repoId, expect user/dataset" };
    }
    if (typeof body.targetRepoId !== "string" || !isValidRepoId(body.targetRepoId)) {
      reply.code(400);
      return { error: "invalid target repoId, expect user/dataset" };
    }
    if (body.sourceRepoIds.includes(body.targetRepoId)) {
      reply.code(400);
      return { error: "target repoId must not be one of the sources" };
    }
    try {
      const parsed = await runMergeScript(body);
      if (parsed.error) {
        const isClientError = ["already exists", "invalid", "not found", "incompatible", "required", "must not"].some(
          (token) => parsed.error?.includes(token),
        );
        reply.code(isClientError ? 400 : 500);
        return parsed;
      }
      return parsed;
    } catch (e: unknown) {
      reply.code(500);
      return { error: (e as Error).message };
    }
  });

  fastify.put<{
    Params: { user: string; name: string };
    Body: { taskPrompts?: unknown };
  }>("/api/datasets/:user/:name/prompts", async (req, reply) => {
    const { user, name } = req.params;
    if (!Array.isArray(req.body.taskPrompts) || !req.body.taskPrompts.every((p) => typeof p === "string")) {
      reply.code(400);
      return { error: "taskPrompts must be an array of strings" };
    }
    try {
      const taskPrompts = writeTasks(user, name, req.body.taskPrompts);
      const datasets = await scanDatasets();
      const dataset = datasets.find((d) => d.user === user && d.dataset === name);
      return dataset ? { ...dataset, taskPrompts } : { repoId: `${user}/${name}`, user, dataset: name, taskPrompts };
    } catch (e: unknown) {
      const msg = (e as Error).message;
      reply.code(msg === "invalid repoId" ? 400 : 404);
      return { error: msg };
    }
  });
}
