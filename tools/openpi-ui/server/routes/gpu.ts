import { FastifyInstance } from "fastify";
import { getGpuSnapshot } from "../lib/gpu-monitor.js";

export async function gpuRoutes(fastify: FastifyInstance) {
  fastify.get("/api/gpu", async () => getGpuSnapshot());
}
