import { FastifyInstance } from "fastify";
import { getRemoteGpuSnapshot, getRemoteHost, listRemoteHosts } from "../lib/remotes.js";

export async function remotesRoutes(fastify: FastifyInstance) {
  fastify.get("/api/remotes", async () => [
    { id: "local", label: "Local (10.16.118.8)", sshTarget: "", repoRoot: "/app", containerName: "local" },
    ...listRemoteHosts(),
  ]);

  fastify.get<{ Params: { id: string } }>("/api/remotes/:id/gpu", async (req, reply) => {
    const host = getRemoteHost(req.params.id);
    if (!host) {
      reply.code(404);
      return { available: false, error: "unknown remote host", gpus: [], processes: [], at: Date.now() };
    }
    return getRemoteGpuSnapshot(host);
  });
}
