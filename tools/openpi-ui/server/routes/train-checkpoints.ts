import { FastifyInstance } from "fastify";
import { listTrainExperiments } from "../lib/train-checkpoints.js";

export async function trainCheckpointsRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { configName?: string } }>("/api/train-checkpoints", async (req) => {
    const configName = req.query.configName?.trim();
    return { experiments: await listTrainExperiments(configName || undefined) };
  });
}