import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(here, "..", "..", "..", "..");
export const UI_ROOT = path.resolve(here, "..", "..");
export const DATA_DIR = path.join(UI_ROOT, ".data");
export const LOGS_DIR = path.join(REPO_ROOT, "logs");
export const JOBS_FILE = path.join(DATA_DIR, "jobs.json");

export const HF_LEROBOT_HOST = "/data2/axgu/.cache/huggingface/lerobot";
export const HF_LEROBOT_CONTAINER = "/root/.cache/huggingface/lerobot";

export const DOCKER_CONTAINER = process.env.OPENPI_UI_CONTAINER || "openpi-RcvkabOpenpi-1";
export const SERVER_PORT = Number(process.env.OPENPI_UI_PORT || 18921);
