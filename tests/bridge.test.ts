import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Bridge = {
  proc: Bun.Subprocess;
  baseUrl: string;
  token: string;
  root: string;
};

async function pickFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to reserve port")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function waitForLog(stream: ReadableStream<Uint8Array>, needle: string): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes(needle)) return;
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error(`did not see ${needle}\n${buffer}`);
}

async function startBridge(): Promise<Bridge> {
  const root = await mkdtemp(join(tmpdir(), "pi-bridge-empty-sessions-"));
  const port = await pickFreePort();
  const token = "test-token";
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", "index.ts"],
    cwd: ".",
    env: {
      PI_CLI: "pi",
      PI_BRIDGE_TOKEN: token,
      PI_BRIDGE_HOST: "127.0.0.1",
      PI_BRIDGE_PORT: String(port),
      PI_SESSIONS_ROOT: root,
    },
    stdout: "pipe",
    stderr: "pipe",
  });


  if (!proc.stdout) {
    throw new Error("bridge stdout is not piped");
  }
  await waitForLog(proc.stdout, "pi-bridge listening on http://127.0.0.1:");

  return { proc, baseUrl: `http://127.0.0.1:${port}`, token, root };
}

async function stopBridge(bridge: Bridge): Promise<void> {
  bridge.proc.kill();
  await bridge.proc.exited;
  await rm(bridge.root, { recursive: true, force: true });
}

function authHeaders(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

let bridge: Bridge;

beforeAll(async () => {
  bridge = await startBridge();
});

afterAll(async () => {
  if (bridge) {
    await stopBridge(bridge);
  }
});

test("health is public and exposes bridge status", async () => {
  const res = await fetch(`${bridge.baseUrl}/health`);
  expect(res.status).toBe(200);

  const body = await res.json() as Record<string, unknown>;
  expect(body).toMatchObject({
    ok: true,
    cli: "pi",
    version: "0.1.0",
    buildSha: null,
    sessions: 0,
    sessionsRoot: bridge.root,
    apnsConfigured: false,
  });
});

test("sessions require auth and return empty collections", async () => {
  const denied = await fetch(`${bridge.baseUrl}/sessions`);
  expect(denied.status).toBe(401);

  const allowed = await fetch(`${bridge.baseUrl}/sessions`, {
    headers: authHeaders(bridge.token),
  });
  expect(allowed.status).toBe(200);

  const body = await allowed.json() as { onDisk?: unknown; live?: unknown };
  expect(body.onDisk).toEqual([]);
  expect(body.live).toEqual([]);
});

test("rejects malformed and oversized bridge requests", async () => {
  const invalidActive = await fetch(`${bridge.baseUrl}/devices/device-token/active`, {
    method: "POST",
    headers: { ...authHeaders(bridge.token), "content-type": "application/json" },
    body: JSON.stringify({ active: "yes" }),
  });
  expect(invalidActive.status).toBe(400);

  const invalidSession = await fetch(`${bridge.baseUrl}/sessions`, {
    method: "POST",
    headers: { ...authHeaders(bridge.token), "content-type": "application/json" },
    body: JSON.stringify({ cwd: 123 }),
  });
  expect(invalidSession.status).toBe(400);

  const oversized = await fetch(`${bridge.baseUrl}/sessions`, {
    method: "POST",
    headers: { ...authHeaders(bridge.token), "content-type": "application/json" },
    body: JSON.stringify({ message: "x".repeat(600_000) }),
  });
  expect(oversized.status).toBe(413);
});
