import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { DATA_DIR, JOBS_FILE } from "./paths.js";
import { JobRecord } from "./types.js";

class JobsStore extends EventEmitter {
  private jobs: JobRecord[] = [];
  private writeQueue: Promise<void> = Promise.resolve();

  constructor() {
    super();
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(JOBS_FILE)) {
      try {
        this.jobs = JSON.parse(fs.readFileSync(JOBS_FILE, "utf8"));
      } catch {
        this.jobs = [];
      }
    }
  }

  list(): JobRecord[] {
    return [...this.jobs].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  getActive(): JobRecord | undefined {
    return this.jobs.find((j) => j.status === "queued" || j.status === "running");
  }

  getActiveForTarget(targetHostId: string): JobRecord | undefined {
    return this.jobs.find(
      (j) =>
        (j.status === "queued" || j.status === "running") &&
        (j.targetHostId || "local") === targetHostId,
    );
  }

  add(job: JobRecord): JobRecord {
    this.jobs.push(job);
    this.persist();
    this.emit("change", job);
    return job;
  }

  update(id: string, patch: Partial<JobRecord>): JobRecord | undefined {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return undefined;
    Object.assign(job, patch);
    this.persist();
    this.emit("change", job);
    return job;
  }

  private persist() {
    const snapshot = JSON.stringify(this.jobs, null, 2);
    this.writeQueue = this.writeQueue.then(
      () =>
        new Promise<void>((resolve) => {
          const tmp = JOBS_FILE + ".tmp";
          fs.writeFile(tmp, snapshot, (err) => {
            if (err) {
              resolve();
              return;
            }
            fs.rename(tmp, JOBS_FILE, () => resolve());
          });
        }),
    );
  }
}

export const jobsStore = new JobsStore();

export function generateJobId(prefix: string): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 6);
  const safe = prefix.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 32);
  return `${safe}_${stamp}_${rand}`;
}

export function logFileFor(repoRoot: string, jobId: string): string {
  return path.join(repoRoot, "logs", `${jobId}.log`);
}
