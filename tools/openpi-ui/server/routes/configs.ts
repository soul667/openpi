import { FastifyInstance } from "fastify";
import { getConfigs } from "../lib/config-registry.js";

export async function configsRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { force?: string } }>("/api/configs", async (req, reply) => {
    try {
      return await getConfigs(req.query.force === "1");
    } catch (e: unknown) {
      reply.code(500);
      return { error: (e as Error).message };
    }
  });
}
