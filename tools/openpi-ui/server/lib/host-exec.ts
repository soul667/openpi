import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function hostExec(
  bashCmd: string,
  opts: { detached?: boolean; cwd?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  const args = ["-lc", bashCmd];
  if (opts.detached) {
    const child = spawn("bash", args, {
      cwd: opts.cwd,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return { stdout: "", stderr: "" };
  }
  try {
    const { stdout, stderr } = await execFileAsync("bash", args, {
      cwd: opts.cwd,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout, stderr };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    throw new Error(err.stderr || err.message || "bash exec failed");
  }
}

export async function hostPgrep(pattern: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("bash", ["-lc", `pgrep -f ${JSON.stringify(pattern)} | head -n1`], {
      maxBuffer: 1024 * 1024,
    });
    const pid = parseInt(stdout.trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

export async function hostPgrepAll(pattern: string): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync("bash", ["-lc", `pgrep -f ${JSON.stringify(pattern)} || true`], {
      maxBuffer: 1024 * 1024,
    });
    return stdout
      .trim()
      .split("\n")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n));
  } catch {
    return [];
  }
}

export async function hostGetPgid(pid: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("bash", ["-lc", `ps -o pgid= -p ${pid} 2>/dev/null | tr -d ' '`], {
      maxBuffer: 64 * 1024,
    });
    const pgid = parseInt(stdout.trim(), 10);
    return Number.isFinite(pgid) ? pgid : null;
  } catch {
    return null;
  }
}

export async function hostKillPgid(pgid: number, signal: "TERM" | "KILL"): Promise<void> {
  try {
    await execFileAsync("bash", ["-lc", `kill -${signal} -${pgid} 2>/dev/null; exit 0`], { maxBuffer: 64 * 1024 });
  } catch {}
}

export async function hostPidAlive(pid: number): Promise<boolean> {
  try {
    await execFileAsync("bash", ["-lc", `kill -0 ${pid} 2>/dev/null`], { maxBuffer: 64 * 1024 });
    return true;
  } catch {
    return false;
  }
}

export async function hostPkill(pattern: string, sig9 = false): Promise<void> {
  const flag = sig9 ? "-9" : "";
  try {
    await execFileAsync("bash", ["-lc", `pkill ${flag} -f ${JSON.stringify(pattern)} 2>/dev/null; exit 0`], {
      maxBuffer: 64 * 1024,
    });
  } catch {}
}