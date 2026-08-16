import { createConnection, type Socket } from "node:net";
import type { OarRequest, OarResponse } from "./protocol.ts";
import { oarSocketPath } from "./paths.ts";

function isRetryable(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.includes("ENOENT") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("ECONNRESET") ||
    msg.includes("EPIPE") ||
    msg.includes("OAR daemon timeout")
  );
}

export class OarClient {
  private readonly socketPath: string;
  private readonly timeoutMs: number;
  private readonly retries: number;

  constructor(opts?: { socketPath?: string; timeoutMs?: number; retries?: number }) {
    this.socketPath = opts?.socketPath ?? oarSocketPath();
    this.timeoutMs = opts?.timeoutMs ?? 5000;
    this.retries = opts?.retries ?? 0;
  }

  async request(req: OarRequest): Promise<OarResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await this.requestOnce(req);
      } catch (error) {
        lastError = error;
        if (attempt === this.retries || !isRetryable(error)) throw error;
        await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private requestOnce(req: OarRequest): Promise<OarResponse> {
    const payload = Buffer.concat([Buffer.from(JSON.stringify(req), "utf8"), Buffer.from([0])]);
    return new Promise<OarResponse>((resolve, reject) => {
      const socket: Socket = createConnection(this.socketPath);
      let buf = Buffer.alloc(0);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`OAR daemon timeout after ${this.timeoutMs}ms (${this.socketPath})`));
      }, this.timeoutMs);

      socket.on("connect", () => {
        socket.write(payload);
      });
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const idx = buf.indexOf(0);
        if (idx === -1) return;
        clearTimeout(timer);
        const text = buf.subarray(0, idx).toString("utf8");
        socket.end();
        try {
          resolve(JSON.parse(text) as OarResponse);
        } catch (error) {
          reject(error);
        }
      });
      socket.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }
}
