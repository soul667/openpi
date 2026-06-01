import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { SERVER_PORT } from "./lib/paths.js";
import { datasetsRoutes } from "./routes/datasets.js";
import { configsRoutes } from "./routes/configs.js";
import { jobsRoutes } from "./routes/jobs.js";
import { gpuRoutes } from "./routes/gpu.js";
import { secretsRoutes } from "./routes/secrets.js";
import { gripperRoutes } from "./routes/gripper.js";
import { normStatsRoutes } from "./routes/norm-stats.js";
import { remotesRoutes } from "./routes/remotes.js";

async function main() {
  const fastify = Fastify({
    logger: { level: "info" },
    bodyLimit: 1024 * 1024,
  });
  await fastify.register(cors, { origin: true });
  await fastify.register(websocket);
  await fastify.register(datasetsRoutes);
  await fastify.register(configsRoutes);
  await fastify.register(jobsRoutes);
  await fastify.register(gpuRoutes);
  await fastify.register(secretsRoutes);
  await fastify.register(gripperRoutes);
  await fastify.register(normStatsRoutes);
  await fastify.register(remotesRoutes);

  fastify.get("/api/health", async () => ({ ok: true, ts: Date.now() }));

  try {
    await fastify.listen({ port: SERVER_PORT, host: "0.0.0.0" });
    fastify.log.info(`openpi-ui server listening on :${SERVER_PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

main();
