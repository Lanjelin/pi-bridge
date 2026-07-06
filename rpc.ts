// Spawn and talk to `pi --mode rpc`.
// Protocol: newline-delimited JSON on stdin/stdout.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AgentEvent, RpcCommand, RpcResponse } from "./types.ts";

export interface RpcSpawnOptions {
  cli: string;
  cwd?: string;
  env?: Record<string, string>;
  args?: string[];
}

type Listener = (event: AgentEvent) => void;
type ResponseListener = (resp: RpcResponse) => void;

let _rpcCounter = 0;

export class PiRpc {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private stderr = "";
  private eventListeners = new Set<Listener>();
  private pending = new Map<string, { resolve: ResponseListener; reject: (e: Error) => void }>();
  private closed = false;
  private tag: string;
  onClose?: (code: number | null) => void;

  constructor(private opts: RpcSpawnOptions) {
    this.tag = `rpc#${++_rpcCounter}`;
  }

  async start(): Promise<void> {
    const args = ["--mode", "rpc", ...(this.opts.args ?? [])];
    const isShell = this.opts.cli.endsWith(".sh");
    const cmd = isShell ? "bash" : this.opts.cli;
    const finalArgs = isShell ? [this.opts.cli, ...args] : args;

    console.log(`[${this.tag}] spawn cmd=${cmd} args=${JSON.stringify(finalArgs)} cwd=${this.opts.cwd}`);

    this.proc = spawn(cmd, finalArgs, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...(this.opts.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });

    console.log(`[${this.tag}] spawned pid=${this.proc.pid}`);

    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
      if (this.stderr.length > 64_000) this.stderr = this.stderr.slice(-32_000);
      for (const line of chunk.split("\n")) {
        if (line.trim()) console.log(`[${this.tag}] STDERR: ${line}`);
      }
    });
    this.proc.on("exit", (code, signal) => {
      console.log(`[${this.tag}] EXIT code=${code} signal=${signal}`);
      if (this.stderr) console.log(`[${this.tag}] final stderr tail:\n${this.stderr.slice(-2000)}`);
      this.closed = true;
      for (const { reject } of this.pending.values()) {
        reject(new Error(`rpc process exited with code ${code}\n${this.stderr}`));
      }
      this.pending.clear();
      this.onClose?.(code);
    });
    this.proc.on("error", (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[${this.tag}] PROC ERROR: ${message}`);
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(err instanceof Error ? err : new Error(message));
      this.pending.clear();
      this.onClose?.(null);
    });
    this.proc.stdin.on("error", (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[${this.tag}] STDIN ERROR: ${message}`);
    });
  }

  private onStdout(chunk: string) {
    this.buffer += chunk;
    let idx = this.buffer.indexOf("\n");
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      idx = this.buffer.indexOf("\n");
      if (!line) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string) {
    console.log(`[${this.tag}] STDOUT<< ${line.slice(0, 300)}${line.length > 300 ? "…" : ""}`);
    let msg: unknown;
    try {
      msg = JSON.parse(line) as unknown;
    } catch {
      console.log(`[${this.tag}] non-JSON stdout line ignored`);
      return;
    }
    if (msg && typeof msg === "object") {
      const record = msg as Record<string, unknown>;
      if (record.type === "response") {
        const response: RpcResponse = {
          id: typeof record.id === "string" ? record.id : undefined,
          type: "response",
          command: typeof record.command === "string" ? record.command : "",
          success: typeof record.success === "boolean" ? record.success : false,
          data: record.data,
          error: typeof record.error === "string" ? record.error : undefined,
        };
        if (response.id && this.pending.has(response.id)) {
          const p = this.pending.get(response.id)!;
          this.pending.delete(response.id);
          p.resolve(response);
        } else {
          console.log(`[${this.tag}] response without matching id (id=${response.id}, pending=[${[...this.pending.keys()].join(",")}])`);
          if (this.pending.size === 1) {
            const [onlyId] = [...this.pending.keys()];
            const p = this.pending.get(onlyId!)!;
            this.pending.delete(onlyId!);
            console.log(`[${this.tag}] fallback-resolving single pending id=${onlyId}`);
            p.resolve(response);
          }
        }
        return;
      }
    }

    for (const l of this.eventListeners) {
      try {
        l(msg as AgentEvent);
      } catch {}
    }
  }

  onEvent(listener: Listener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async send(cmd: RpcCommand): Promise<RpcResponse> {
    if (this.closed || !this.proc) {
      console.log(`[${this.tag}] send FAILED — closed=${this.closed} proc=${!!this.proc} cmd=${cmd.type}`);
      throw new Error("rpc closed");
    }
    const id = cmd.id ?? randomUUID();
    const withId = { ...cmd, id } satisfies RpcCommand;
    const payload = JSON.stringify(withId);
    console.log(`[${this.tag}] STDIN>> ${payload.slice(0, 300)}${payload.length > 300 ? "…" : ""}`);
    return new Promise<RpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc!.stdin.write(payload + "\n", (err) => {
        if (err) {
          console.log(`[${this.tag}] stdin write error: ${err.message}`);
          this.pending.delete(id);
          reject(err);
        }
      });
      setTimeout(() => {
        if (this.pending.has(id)) {
          console.log(`[${this.tag}] send TIMEOUT id=${id} cmd=${cmd.type}`);
          this.pending.delete(id);
          reject(new Error(`rpc send timeout for ${cmd.type}`));
        }
      }, 60_000);
    });
  }

  async stop(): Promise<void> {
    if (!this.proc || this.closed) return;
    console.log(`[${this.tag}] stop() called`);
    this.closed = true;
    try {
      this.proc.stdin.end();
    } catch {}
    try {
      this.proc.kill("SIGTERM");
    } catch {}
  }

  get isAlive(): boolean {
    return !this.closed && this.proc !== null;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  get stderrTail(): string {
    return this.stderr;
  }
}
