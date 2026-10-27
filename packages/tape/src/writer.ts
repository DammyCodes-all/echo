import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import type { TapeEvent } from "@echo/contracts";

export class TapeWriter {
  private fd: number | null = null;

  constructor(private readonly path: string) {}

  append(event: TapeEvent, options: { sync?: boolean } = {}): void {
    this.fd ??= openSync(this.path, "a");
    writeSync(this.fd, `${JSON.stringify(event)}\n`);
    if (options.sync) fsyncSync(this.fd);
  }

  flush(): void {
    if (this.fd !== null) fsyncSync(this.fd);
  }

  close(): void {
    if (this.fd === null) return;
    fsyncSync(this.fd);
    closeSync(this.fd);
    this.fd = null;
  }
}
