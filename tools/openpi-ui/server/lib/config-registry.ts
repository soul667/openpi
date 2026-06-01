import { dockerExec } from "./docker.js";
import { ConfigInfo } from "./types.js";

let cache: { at: number; data: ConfigInfo[] } | null = null;
const TTL = 60_000;

const PY_SNIPPET = `
import json
import openpi.training.config as C
out = []
for cfg in C._CONFIGS:
    repo = None
    try:
        r = getattr(cfg.data, "repo_id", None)
        if isinstance(r, str) and r:
            repo = r
    except Exception:
        repo = None
    out.append({
        "name": cfg.name,
        "modelType": type(cfg.model).__name__,
        "defaultRepoId": repo,
        "numTrainSteps": cfg.num_train_steps,
        "batchSize": cfg.batch_size,
    })
print(json.dumps(out))
`.trim();

export async function getConfigs(force = false): Promise<ConfigInfo[]> {
  if (!force && cache && Date.now() - cache.at < TTL) {
    return cache.data;
  }
  const b64 = Buffer.from(PY_SNIPPET, "utf8").toString("base64");
  const cmd = `cd /app && echo ${b64} | base64 -d | uv run python - 2>/dev/null`;
  const { stdout } = await dockerExec(cmd);
  const lastBrace = stdout.lastIndexOf("[");
  const json = lastBrace >= 0 ? stdout.slice(lastBrace) : stdout;
  const parsed = JSON.parse(json) as ConfigInfo[];
  cache = { at: Date.now(), data: parsed };
  return parsed;
}
