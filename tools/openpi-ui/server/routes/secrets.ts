import { FastifyInstance } from "fastify";
import {
  clearWandbKey,
  getPreCommand,
  getWandbKey,
  maskKey,
  resetPreCommand,
  setPreCommand,
  setWandbKey,
} from "../lib/secrets-store.js";

export async function secretsRoutes(fastify: FastifyInstance) {
  fastify.get("/api/secrets/wandb", async () => {
    const key = getWandbKey();
    return {
      hasKey: !!key,
      maskedKey: key ? maskKey(key) : null,
    };
  });

  fastify.put<{ Body: { key?: string } }>("/api/secrets/wandb", async (req, reply) => {
    const key = (req.body?.key || "").trim();
    if (!key) {
      reply.code(400);
      return { error: "empty key" };
    }
    setWandbKey(key);
    return { hasKey: true, maskedKey: maskKey(key) };
  });

  fastify.delete("/api/secrets/wandb", async () => {
    clearWandbKey();
    return { hasKey: false, maskedKey: null };
  });

  fastify.get("/api/settings/pre-command", async () => {
    return { preCommand: getPreCommand() };
  });

  fastify.put<{ Body: { preCommand?: string } }>("/api/settings/pre-command", async (req) => {
    const cmd = req.body?.preCommand ?? "";
    setPreCommand(cmd);
    return { preCommand: getPreCommand() };
  });

  fastify.delete("/api/settings/pre-command", async () => {
    resetPreCommand();
    return { preCommand: getPreCommand() };
  });
}
