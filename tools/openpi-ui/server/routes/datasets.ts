import { FastifyInstance } from "fastify";
import { scanDatasets, writeTasks } from "../lib/dataset-scanner.js";

export async function datasetsRoutes(fastify: FastifyInstance) {
  fastify.get("/api/datasets", async () => scanDatasets());

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
