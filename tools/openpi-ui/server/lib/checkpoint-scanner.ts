import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./paths.js";

export interface LocalCheckpointInfo {
  relativePath: string;
  absolutePath: string;
  configName: string;
  expName: string;
  stepLabel: string;
  mtimeMs: number;
  backendHint?: "jax" | "torch";
}

function isCheckpointLeaf(dir: string): boolean {
  try {
    const names = new Set(fs.readdirSync(dir));
    if (names.has("params") || names.has("_CHECKPOINT_METADATA")) return true;
    if (names.has("model.safetensors")) return true;
    return false;
  } catch {
    return false;
  }
}

function backendHint(dir: string): "jax" | "torch" | undefined {
  try {
    const names = new Set(fs.readdirSync(dir));
    if (names.has("model.safetensors")) return "torch";
    if (names.has("params") || names.has("_CHECKPOINT_METADATA")) return "jax";
  } catch {}
  return undefined;
}

export function listLocalCheckpoints(root = path.join(REPO_ROOT, "checkpoints")): LocalCheckpointInfo[] {
  const out: LocalCheckpointInfo[] = [];
  if (!fs.existsSync(root)) return out;

  const walk = (dir: string, relParts: string[]) => {
    if (isCheckpointLeaf(dir)) {
      const stat = fs.statSync(dir);
      const relativePath = relParts.join("/");
      const configName = relParts[0] || "";
      const expName = relParts[1] || "";
      const stepLabel = relParts[relParts.length - 1] || "";
      out.push({
        relativePath,
        absolutePath: dir,
        configName,
        expName,
        stepLabel,
        mtimeMs: stat.mtimeMs,
        backendHint: backendHint(dir),
      });
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (ent.name.startsWith(".")) continue;
      walk(path.join(dir, ent.name), [...relParts, ent.name]);
    }
  };

  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
    walk(path.join(root, ent.name), [ent.name]);
  }

  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}