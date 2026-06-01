import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./paths.js";

const SECRETS_FILE = path.join(DATA_DIR, "secrets.json");

interface SecretsShape {
  wandbApiKey?: string;
  preCommand?: string;
}

const DEFAULT_PRE_COMMAND = "export http_proxy=http://127.0.0.1:1081 https_proxy=http://127.0.0.1:1081";

function readAll(): SecretsShape {
  try {
    if (!fs.existsSync(SECRETS_FILE)) return {};
    return JSON.parse(fs.readFileSync(SECRETS_FILE, "utf8")) as SecretsShape;
  } catch {
    return {};
  }
}

function writeAll(s: SecretsShape) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = SECRETS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, SECRETS_FILE);
  try {
    fs.chmodSync(SECRETS_FILE, 0o600);
  } catch {}
}

export function getWandbKey(): string | null {
  const v = readAll().wandbApiKey;
  return v && v.trim() ? v.trim() : null;
}

export function setWandbKey(key: string): void {
  const s = readAll();
  s.wandbApiKey = key.trim();
  writeAll(s);
}

export function clearWandbKey(): void {
  const s = readAll();
  delete s.wandbApiKey;
  writeAll(s);
}

export function getPreCommand(): string {
  const v = readAll().preCommand;
  if (v === undefined) return DEFAULT_PRE_COMMAND;
  return v;
}

export function setPreCommand(cmd: string): void {
  const s = readAll();
  s.preCommand = cmd;
  writeAll(s);
}

export function resetPreCommand(): void {
  const s = readAll();
  delete s.preCommand;
  writeAll(s);
}

export function maskKey(key: string): string {
  if (key.length <= 8) return "***";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}
