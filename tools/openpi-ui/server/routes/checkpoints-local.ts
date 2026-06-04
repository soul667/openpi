import { FastifyInstance } from "fastify";
import { listLocalCheckpoints } from "../lib/checkpoint-scanner.js";

export async function checkpointsLocalRoutes(fastify: FastifyInstance) {
  fastify.get("/api/checkpoints/local", async () => ({
    checkpoints: listLocalCheckpoints(),
  }));
}