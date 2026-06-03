import fs from "node:fs";
import path from "node:path";
import { HF_LEROBOT_HOST } from "./paths.js";
import { DatasetInfo } from "./types.js";

const SKIP = new Set([".locks", ".cache", ".gitattributes", "datasets--"]);
const REPO_ID_PARAM = /^[A-Za-z0-9_.\-]+$/;

interface LeRobotInfoJson {
  total_episodes?: number;
  total_frames?: number;
  total_videos?: number;
  fps?: number;
  robot_type?: string;
  codebase_version?: string;
}

interface TaskJsonLine {
  task?: string;
  [key: string]: unknown;
}

function readTasks(datasetDir: string): string[] {
  const p = path.join(datasetDir, "meta", "tasks.jsonl");
  if (!fs.existsSync(p)) return [];
  const out: string[] = [];
  try {
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const task = JSON.parse(line) as { task?: string };
      if (task.task && !out.includes(task.task)) out.push(task.task);
    }
  } catch {}
  return out;
}

function normalizeTaskPrompts(taskPrompts: string[]): string[] {
  const out: string[] = [];
  for (const prompt of taskPrompts) {
    const trimmed = prompt.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

export function writeTasks(user: string, dataset: string, taskPrompts: string[]): string[] {
  if (!REPO_ID_PARAM.test(user) || !REPO_ID_PARAM.test(dataset)) {
    throw new Error("invalid repoId");
  }
  const datasetDir = path.join(HF_LEROBOT_HOST, user, dataset);
  const resolvedBase = path.resolve(HF_LEROBOT_HOST);
  const resolvedDataset = path.resolve(datasetDir);
  if (!resolvedDataset.startsWith(`${resolvedBase}${path.sep}`) || !fs.existsSync(resolvedDataset)) {
    throw new Error("dataset not found");
  }
  const metaDir = path.join(resolvedDataset, "meta");
  fs.mkdirSync(metaDir, { recursive: true });
  const normalized = normalizeTaskPrompts(taskPrompts);
  const tasksPath = path.join(metaDir, "tasks.jsonl");
  const existingRows: TaskJsonLine[] = [];
  if (fs.existsSync(tasksPath)) {
    for (const line of fs.readFileSync(tasksPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        existingRows.push(JSON.parse(line) as TaskJsonLine);
      } catch {
        existingRows.push({});
      }
    }
  }
  const rows = normalized.map((task, idx) => ({ ...(existingRows[idx] || {}), task }));
  const content = rows.map((row) => JSON.stringify(row)).join("\n");
  fs.writeFileSync(tasksPath, content ? `${content}\n` : "", "utf8");
  return normalized;
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
        taskPrompts: readTasks(datasetDir),
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
