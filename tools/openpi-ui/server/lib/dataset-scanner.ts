import fs from "node:fs";
import path from "node:path";
import { HF_LEROBOT_HOST } from "./paths.js";
import { DatasetInfo } from "./types.js";

const SKIP = new Set([".locks", ".cache", ".gitattributes", "datasets--"]);

interface LeRobotInfoJson {
  total_episodes?: number;
  total_frames?: number;
  total_videos?: number;
  fps?: number;
  robot_type?: string;
  codebase_version?: string;
}

function dirSize(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      try {
        if (e.isDirectory()) stack.push(p);
        else if (e.isFile()) total += fs.statSync(p).size;
      } catch {}
    }
  }
  return total;
}

export async function scanDatasets(): Promise<DatasetInfo[]> {
  if (!fs.existsSync(HF_LEROBOT_HOST)) return [];
  const result: DatasetInfo[] = [];
  const users = fs.readdirSync(HF_LEROBOT_HOST, { withFileTypes: true });
  for (const u of users) {
    if (!u.isDirectory()) continue;
    if (u.name.startsWith(".") || SKIP.has(u.name)) continue;
    const userDir = path.join(HF_LEROBOT_HOST, u.name);
    let datasets: fs.Dirent[];
    try {
      datasets = fs.readdirSync(userDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of datasets) {
      if (!d.isDirectory()) continue;
      if (d.name.startsWith(".")) continue;
      const datasetDir = path.join(userDir, d.name);
      const infoPath = path.join(datasetDir, "meta", "info.json");
      const fallbackInfoPath = path.join(datasetDir, "info.json");
      let info: LeRobotInfoJson | null = null;
      let hasInfoJson = false;
      const useInfo = fs.existsSync(infoPath) ? infoPath : fs.existsSync(fallbackInfoPath) ? fallbackInfoPath : null;
      if (useInfo) {
        try {
          info = JSON.parse(fs.readFileSync(useInfo, "utf8"));
          hasInfoJson = true;
        } catch {}
      }
      let stat: fs.Stats | null = null;
      try {
        stat = fs.statSync(datasetDir);
      } catch {}
      result.push({
        repoId: `${u.name}/${d.name}`,
        user: u.name,
        dataset: d.name,
        totalEpisodes: info?.total_episodes,
        totalFrames: info?.total_frames,
        totalVideos: info?.total_videos,
        fps: info?.fps,
        robotType: info?.robot_type,
        codebaseVersion: info?.codebase_version,
        sizeBytes: dirSize(datasetDir),
        hasInfoJson,
        lastModifiedMs: stat ? stat.mtimeMs : 0,
      });
    }
  }
  result.sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);
  return result;
}
