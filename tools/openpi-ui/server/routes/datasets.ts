import { FastifyInstance } from "fastify";
import { scanDatasets } from "../lib/dataset-scanner.js";

export async function datasetsRoutes(fastify: FastifyInstance) {
  fastify.get("/api/datasets", async () => scanDatasets());
}
