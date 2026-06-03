import { FastifyInstance } from "fastify";
import { getRemoteGpuSnapshot, getRemoteHost, listRemoteCheckpoints, listRemoteHosts, pullRemoteCheckpoint } from "../lib/remotes.js";

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

  fastify.get<{ Params: { id: string } }>("/api/remotes/:id/checkpoints", async (req, reply) => {
    const host = getRemoteHost(req.params.id);
    if (!host) {
      reply.code(404);
      return { error: "unknown remote host", checkpoints: [] };
    }
    try {
      return { checkpoints: await listRemoteCheckpoints(host) };
    } catch (e: unknown) {
      reply.code(500);
      return { error: (e as Error).message, checkpoints: [] };
    }
  });

  fastify.post<{ Params: { id: string }; Body: { relativePath?: string } }>("/api/remotes/:id/checkpoints/pull", async (req, reply) => {
    const host = getRemoteHost(req.params.id);
    if (!host) {
      reply.code(404);
      return { error: "unknown remote host" };
    }
    const relativePath = (req.body?.relativePath || "").trim();
    try {
      return { ok: true, ...(await pullRemoteCheckpoint(host, relativePath)) };
    } catch (e: unknown) {
      reply.code(500);
      return { error: (e as Error).message };
    }
  });
}
