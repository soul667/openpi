import fs from "node:fs";
import { EventEmitter } from "node:events";

export class LogTailer extends EventEmitter {
  private fd: number | null = null;
  private offset = 0;
  private watcher: fs.FSWatcher | null = null;
  private filePath: string;
  private closed = false;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(filePath: string, startOffset = 0) {
    super();
    this.filePath = filePath;
    this.offset = startOffset;
  }

  async start(): Promise<void> {
    await this.waitForFile();
    if (this.closed) return;
    this.fd = fs.openSync(this.filePath, "r");
    await this.drain();
    this.watcher = fs.watch(this.filePath, () => this.drain().catch(() => {}));
    this.pollTimer = setInterval(() => this.drain().catch(() => {}), 1000);
  }

  private async waitForFile(): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!this.closed && Date.now() < deadline) {
      try {
        fs.statSync(this.filePath);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }

  private async drain(): Promise<void> {
    if (this.fd === null || this.closed) return;
    const stat = fs.fstatSync(this.fd);
    if (stat.size < this.offset) {
      this.offset = 0;
    }
    while (this.offset < stat.size && !this.closed) {
      const len = Math.min(stat.size - this.offset, 64 * 1024);
      const buf = Buffer.alloc(len);
      const r = fs.readSync(this.fd, buf, 0, len, this.offset);
      if (r <= 0) break;
      this.offset += r;
      this.emit("data", buf.subarray(0, r).toString("utf8"));
    }
  }

  get currentOffset(): number {
    return this.offset;
  }

  close(): void {
    this.closed = true;
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {}
      this.fd = null;
    }
  }
}

export function readLogChunk(filePath: string, fromByte: number): { chunk: string; nextByte: number; eof: boolean } {
  if (!fs.existsSync(filePath)) {
    return { chunk: "", nextByte: 0, eof: true };
  }
  const stat = fs.statSync(filePath);
  if (fromByte >= stat.size) {
    return { chunk: "", nextByte: stat.size, eof: false };
  }
  const fd = fs.openSync(filePath, "r");
  try {
    const len = Math.min(stat.size - fromByte, 4 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    const r = fs.readSync(fd, buf, 0, len, fromByte);
    return { chunk: buf.subarray(0, r).toString("utf8"), nextByte: fromByte + r, eof: false };
  } finally {
    fs.closeSync(fd);
  }
}
