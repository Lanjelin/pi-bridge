import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Bridge = {
  proc: Bun.Subprocess;
  baseUrl: string;
  token: string;
  sessionsRoot: string;
  cleanupDirs: string[];
};

type FakePi = {
  cliPath: string;
  dir: string;
};

async function pickFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
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

async function waitForBridge(baseUrl: string): Promise<void> {
  for (let i = 0; i < 5000; i++) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.status === 200) return;
    } catch {}
  }
  throw new Error(`bridge never became ready at ${baseUrl}`);
}

async function createFakePi(): Promise<FakePi> {
  const dir = await mkdtemp(join(tmpdir(), "pi-bridge-fake-pi-"));
  const cliPath = join(dir, "pi.mjs");
  const script = [
    "#!/usr/bin/env bun",
    "import readline from \"node:readline\";",
    "",
    "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });",
    "",
    "function send(value) {",
    "  process.stdout.write(JSON.stringify(value) + \"\\n\");",
    "}",
    "",
    "function response(id, command, data = {}) {",
    "  send({ type: \"response\", id, command, success: true, data });",
    "}",
    "",
    "function assistantMessages(text) {",
    "  return [{ role: \"assistant\", content: [{ type: \"text\", text }] }];",
    "}",
    "",
    "rl.on(\"line\", (line) => {",
    "  if (!line.trim()) return;",
    "  let req;",
    "  try {",
    "    req = JSON.parse(line);",
    "  } catch {",
    "    return;",
    "  }",
    "",
    "  const id = typeof req.id === \"string\" ? req.id : undefined;",
    "  const type = typeof req.type === \"string\" ? req.type : \"\";",
    "",
    "  switch (type) {",
    "    case \"get_state\":",
    "      response(id, type, { status: \"idle\" });",
    "      return;",
    "    case \"get_messages\":",
    "      response(id, type, { messages: [], latestSeq: 0 });",
    "      return;",
    "    case \"get_available_models\":",
    "      response(id, type, {",
    "        models: [",
    "          { provider: \"fake\", id: \"alpha\" },",
    "          { provider: \"other\", id: \"beta\" },",
    "        ],",
    "      });",
    "      return;",
    "    case \"get_session_stats\":",
    "      response(id, type, { messages: 0, tokens: 0 });",
    "      return;",
    "    case \"get_commands\":",
    "      response(id, type, { commands: [] });",
    "      return;",
    "    case \"prompt\":",
    "    case \"steer\":",
    "    case \"follow_up\":",
    "      send({ type: \"turn_start\" });",
    "      send({ type: \"message_start\" });",
    "      send({ type: \"message_update\", delta: `working:${type}` });",
    "      send({ type: \"agent_end\", messages: assistantMessages(`${type} reply`) });",
    "      response(id, type, { ok: true });",
    "      return;",
    "    case \"abort\":",
    "    case \"set_model\":",
    "    case \"cycle_model\":",
    "    case \"set_thinking_level\":",
    "    case \"compact\":",
    "    case \"switch_session\":",
    "    case \"set_session_name\":",
    "      response(id, type, { ok: true });",
    "      return;",
    "    default:",
    "      response(id, type, { ok: true });",
    "  }",
    "});",
    "",
    "rl.on(\"close\", () => process.exit(0));",
    "",
  ].join("\n");
  await writeFile(cliPath, script);
  await chmod(cliPath, 0o755);
  return { cliPath, dir };
}

async function startBridge(cliPath: string): Promise<Bridge> {
  const sessionsRoot = await mkdtemp(join(tmpdir(), "pi-bridge-empty-sessions-"));
  const port = await pickFreePort();
  const token = "test-token";
  const baseUrl = `http://127.0.0.1:${port}`;
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", "index.ts"],
    cwd: ".",
    env: {
      PI_CLI: cliPath,
      PI_BRIDGE_TOKEN: token,
      PI_BRIDGE_HOST: "127.0.0.1",
      PI_BRIDGE_PORT: String(port),
      PI_SESSIONS_ROOT: sessionsRoot,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  await waitForBridge(baseUrl);
  return { proc, baseUrl, token, sessionsRoot, cleanupDirs: [sessionsRoot] };
}

async function stopBridge(bridge: Bridge): Promise<void> {
  bridge.proc.kill();
  await bridge.proc.exited;
  await Promise.all(bridge.cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })));
}

function authHeaders(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

async function createSession(baseUrl: string, token: string): Promise<{ id: string; keepAlive: boolean }> {
  const res = await fetch(`${baseUrl}/sessions`, {
    method: "POST",
    headers: { ...authHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({ cwd: process.cwd() }),
  });
  expect(res.status).toBe(200);
  return await res.json() as { id: string; keepAlive: boolean };
}

async function openWebSocket(url: string): Promise<WebSocket> {
  return await new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", () => reject(new Error(`failed to open websocket: ${url}`)), { once: true });
  });
}

async function collectMessages(ws: WebSocket, count: number): Promise<Array<Record<string, unknown>>> {
  return await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
    const messages: Array<Record<string, unknown>> = [];

    function cleanup(): void {
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("close", onClose);
      ws.removeEventListener("error", onError);
    }

    function onMessage(event: MessageEvent): void {
      if (typeof event.data !== "string") {
        cleanup();
        reject(new Error("expected websocket text frame"));
        return;
      }
      messages.push(JSON.parse(event.data) as Record<string, unknown>);
      if (messages.length >= count) {
        cleanup();
        resolve(messages);
      }
    }

    function onClose(): void {
      cleanup();
      reject(new Error("websocket closed before enough messages arrived"));
    }

    function onError(): void {
      cleanup();
      reject(new Error("websocket error"));
    }

    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", onClose, { once: true });
    ws.addEventListener("error", onError, { once: true });
  });
}

let fakePi: FakePi;
let bridge: Bridge;

beforeAll(async () => {
  fakePi = await createFakePi();
  bridge = await startBridge(fakePi.cliPath);
});

afterAll(async () => {
  if (bridge) {
    await stopBridge(bridge);
  }
  if (fakePi) {
    await rm(fakePi.dir, { recursive: true, force: true });
  }
});

test("health is public and exposes bridge status", async () => {
  const res = await fetch(`${bridge.baseUrl}/health`);
  expect(res.status).toBe(200);

  const body = await res.json() as Record<string, unknown>;
  expect(body).toMatchObject({
    ok: true,
    cli: fakePi.cliPath,
    version: "0.1.0",
    buildSha: null,
    sessions: 0,
    sessionsRoot: bridge.sessionsRoot,
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

test("streams turn-scoped events and fast-forwards replay with sinceSeq", async () => {
  const session = await createSession(bridge.baseUrl, bridge.token);

  const ws = await openWebSocket(`${bridge.baseUrl.replace("http://", "ws://")}/sessions/${session.id}/events?token=${bridge.token}`);
  const promptOne = fetch(`${bridge.baseUrl}/sessions/${session.id}/prompt`, {
    method: "POST",
    headers: { ...authHeaders(bridge.token), "content-type": "application/json" },
    body: JSON.stringify({ message: "first prompt" }),
  });

  const firstEventsPromise = collectMessages(ws, 4);
  await promptOne;
  const firstEvents = await firstEventsPromise;

  expect(firstEvents.map((e) => e.type)).toEqual([
    "turn_start",
    "message_start",
    "message_update",
    "agent_end",
  ]);

  const firstSeqs = firstEvents.map((e) => e.seq as number);
  expect(firstSeqs).toEqual([...firstSeqs].sort((a, b) => a - b));
  const firstTurnId = firstEvents[0]?.turnId as string | undefined;
  expect(firstTurnId).toBeTruthy();
  expect(new Set(firstEvents.map((e) => e.turnId)).size).toBe(1);
  ws.close();

  const lastSeq = firstSeqs[firstSeqs.length - 1]!;
  const replayWs = await openWebSocket(`${bridge.baseUrl.replace("http://", "ws://")}/sessions/${session.id}/events?token=${bridge.token}&sinceSeq=${lastSeq}`);
  const secondPrompt = fetch(`${bridge.baseUrl}/sessions/${session.id}/prompt`, {
    method: "POST",
    headers: { ...authHeaders(bridge.token), "content-type": "application/json" },
    body: JSON.stringify({ message: "second prompt" }),
  });

  const secondEventsPromise = collectMessages(replayWs, 4);
  await secondPrompt;
  const secondEvents = await secondEventsPromise;

  expect(secondEvents.map((e) => e.type)).toEqual([
    "turn_start",
    "message_start",
    "message_update",
    "agent_end",
  ]);
  expect(secondEvents[0]?.seq).toBe(lastSeq + 1);
  expect(new Set(secondEvents.map((e) => e.turnId)).size).toBe(1);
  expect(secondEvents[0]?.turnId).not.toBe(firstTurnId);

  replayWs.close();
});

test("keep-alive toggles the live session record", async () => {
  const session = await createSession(bridge.baseUrl, bridge.token);

  const res = await fetch(`${bridge.baseUrl}/sessions/${session.id}/keep-alive`, {
    method: "POST",
    headers: { ...authHeaders(bridge.token), "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, keepAlive: true });

  const sessionsRes = await fetch(`${bridge.baseUrl}/sessions`, {
    headers: authHeaders(bridge.token),
  });
  expect(sessionsRes.status).toBe(200);
  const sessions = await sessionsRes.json() as { live?: Array<{ id?: string; keepAlive?: boolean }> };
  expect(sessions.live).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: session.id, keepAlive: true }),
  ]));
});
