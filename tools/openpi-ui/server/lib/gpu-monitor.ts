import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GpuInfo, GpuProcInfo, GpuSnapshot } from "./types.js";

const execFileAsync = promisify(execFile);

async function nvidiaSmi(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("nvidia-smi", args, { maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

function parseCsv(text: string): string[][] {
  return text
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => l.split(",").map((c) => c.trim()));
}

async function resolveProcessOwners(pids: number[]): Promise<Map<number, { user: string; cmd: string }>> {
  const out = new Map<number, { user: string; cmd: string }>();
  if (pids.length === 0) return out;
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "pid=,user=,args=", "-p", pids.join(",")], {
      maxBuffer: 4 * 1024 * 1024,
    });
    for (const line of stdout.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
      if (m) {
        out.set(parseInt(m[1], 10), { user: m[2], cmd: m[3].trim() });
      }
    }
  } catch {}
  return out;
}

export async function getGpuSnapshot(): Promise<GpuSnapshot> {
  let gpusRaw: string[][] = [];
  let procsRaw: string[][] = [];
  try {
    const gpusText = await nvidiaSmi([
      "--query-gpu=index,name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu",
      "--format=csv,noheader,nounits",
    ]);
    gpusRaw = parseCsv(gpusText);
  } catch (e: unknown) {
    return { available: false, error: (e as Error).message, gpus: [], processes: [], at: Date.now() };
  }
  try {
    const procsText = await nvidiaSmi([
      "--query-compute-apps=gpu_uuid,pid,process_name,used_memory",
      "--format=csv,noheader,nounits",
    ]);
    procsRaw = parseCsv(procsText);
  } catch {}

  const gpus: GpuInfo[] = gpusRaw.map((row) => ({
    index: parseInt(row[0], 10),
    name: row[1],
    memoryTotalMib: parseInt(row[2], 10),
    memoryUsedMib: parseInt(row[3], 10),
    memoryFreeMib: parseInt(row[4], 10),
    utilizationPct: parseInt(row[5], 10),
    temperatureC: parseInt(row[6], 10),
  }));

  let uuidToIndex = new Map<string, number>();
  try {
    const uuidText = await nvidiaSmi(["--query-gpu=index,uuid", "--format=csv,noheader"]);
    for (const row of parseCsv(uuidText)) {
      uuidToIndex.set(row[1], parseInt(row[0], 10));
    }
  } catch {}

  const pids = procsRaw.map((r) => parseInt(r[1], 10)).filter((n) => Number.isFinite(n));
  const owners = await resolveProcessOwners(pids);

  const processes: GpuProcInfo[] = procsRaw.map((row) => {
    const pid = parseInt(row[1], 10);
    const owner = owners.get(pid);
    return {
      gpuIndex: uuidToIndex.get(row[0]) ?? -1,
      pid,
      processName: row[2],
      memoryUsedMib: parseInt(row[3], 10),
      user: owner?.user,
      cmd: owner?.cmd,
    };
  });

  return { available: true, gpus, processes, at: Date.now() };
}
