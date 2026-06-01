import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DOCKER_CONTAINER } from "./paths.js";

const execFileAsync = promisify(execFile);

export async function dockerExec(bashCmd: string, opts: { detached?: boolean } = {}): Promise<{ stdout: string; stderr: string }> {
  const args = ["exec"];
  if (opts.detached) args.push("-d");
  args.push(DOCKER_CONTAINER, "bash", "-lc", bashCmd);
  try {
    const { stdout, stderr } = await execFileAsync("docker", args, {
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout, stderr };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    throw new Error(err.stderr || err.message || "docker exec failed");
  }
}

export async function dockerExecDetached(bashCmd: string): Promise<void> {
  await dockerExec(bashCmd, { detached: true });
}

export async function dockerPgrep(pattern: string): Promise<number | null> {
  try {
    const { stdout } = await dockerExec(`pgrep -f ${JSON.stringify(pattern)} | head -n1`);
    const pid = parseInt(stdout.trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

export async function dockerPgrepAll(pattern: string): Promise<number[]> {
  try {
    const { stdout } = await dockerExec(`pgrep -f ${JSON.stringify(pattern)} || true`);
    return stdout
      .trim()
      .split("\n")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n));
  } catch {
    return [];
  }
}

export async function dockerGetPgid(pid: number): Promise<number | null> {
  try {
    const { stdout } = await dockerExec(`ps -o pgid= -p ${pid} 2>/dev/null | tr -d ' '`);
    const pgid = parseInt(stdout.trim(), 10);
    return Number.isFinite(pgid) ? pgid : null;
  } catch {
    return null;
  }
}

export async function dockerKillPgid(pgid: number, signal: "TERM" | "KILL"): Promise<void> {
  try {
    await dockerExec(`kill -${signal} -${pgid} 2>/dev/null; exit 0`);
  } catch {}
}

export async function dockerPkill(pattern: string): Promise<void> {
  try {
    await dockerExec(`pkill -f ${JSON.stringify(pattern)} 2>/dev/null; exit 0`);
  } catch {}
}

export async function dockerPkill9(pattern: string): Promise<void> {
  try {
    await dockerExec(`pkill -9 -f ${JSON.stringify(pattern)} 2>/dev/null; exit 0`);
  } catch {}
}

export async function dockerContainerRunning(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("docker", [
      "inspect",
      "-f",
      "{{.State.Running}}",
      DOCKER_CONTAINER,
    ]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}
