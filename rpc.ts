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
      // Log each stderr line immediately
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
    this.proc.on("error", (err) => {
      console.log(`[${this.tag}] PROC ERROR: ${err.message}`);
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
      this.onClose?.(null);
    });
    this.proc.stdin.on("error", (err) => {
      console.log(`[${this.tag}] STDIN ERROR: ${err.message}`);
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
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      console.log(`[${this.tag}] non-JSON stdout line ignored`);
      return;
    }
    if (msg && msg.type === "response") {
      const id = msg.id as string | undefined;
      if (id && this.pending.has(id)) {
        const p = this.pending.get(id)!;
        this.pending.delete(id);
        p.resolve(msg as RpcResponse);
      } else {
        console.log(`[${this.tag}] response without matching id (id=${id}, pending=[${[...this.pending.keys()].join(",")}])`);
        // Fallback: if only one pending, resolve it
        if (this.pending.size === 1) {
          const [onlyId] = [...this.pending.keys()];
          const p = this.pending.get(onlyId!)!;
          this.pending.delete(onlyId!);
          console.log(`[${this.tag}] fallback-resolving single pending id=${onlyId}`);
          p.resolve(msg as RpcResponse);
        }
      }
      return;
    }
    // Everything else is an AgentEvent (or extension UI request).
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
    const id = (cmd as any).id ?? randomUUID();
    const withId = { ...cmd, id } as RpcCommand;
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
      // Safety timeout so we don't hang forever
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

  get stderrTail(): string {
    return this.stderr;
  }
}
