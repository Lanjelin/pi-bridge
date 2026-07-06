// pi-bridge entry point.
//
// Env vars:
//   PI_BRIDGE_TOKEN  - bearer token required on all requests (required)
//   PI_CLI           - path to pi launcher (default: "pi")
//   PI_BRIDGE_PORT   - port to bind (default: 7171)
//   PI_BRIDGE_HOST   - host to bind (default: "0.0.0.0")

import { listSessions, SESSIONS_ROOT } from "./sessions.ts";

import { SessionManager } from "./manager.ts";
import { APNs } from "./apns.ts";
import type { AgentEvent } from "./types.ts";

const TOKEN = process.env.PI_BRIDGE_TOKEN;
if (!TOKEN) {
  console.error("PI_BRIDGE_TOKEN must be set");
  process.exit(1);
}
const CLI = process.env.PI_CLI ?? "pi";
const PORT = Number(process.env.PI_BRIDGE_PORT ?? 7171);
const HOST = process.env.PI_BRIDGE_HOST ?? "0.0.0.0";

const manager = new SessionManager(CLI);
const apns = APNs.fromEnv();

/**
 * Per-session set of APNs device tokens. iOS clients register via
 * POST /sessions/:id/notifications/subscribe and we keep them in memory
 * for the bridge's lifetime. On `agent_end` we push every token in the
 * session's bucket. Tokens that come back as `BadDeviceToken` /
 * `Unregistered` are pruned.
 */
const pushSubscriptions = new Map<string, Set<string>>();

/**
 * Per-device foreground state, updated by iOS via
 * `POST /devices/:token/active`. We default to `true` (foreground) so
 * the bridge does NOT spam pushes to a device that hasn't reported its
 * phase yet, e.g. immediately after a bridge restart.
 */
const deviceActive = new Map<string, boolean>();

/**
 * Per-device pointer to the session id the user is currently looking
 * at, updated by iOS via `POST /devices/:token/viewing`. Combined with
 * `deviceActive`, the push filter only suppresses notifications when
 * the user is actively in that exact session in the foreground.
 */
const deviceViewing = new Map<string, string | null>();
function formatRequestLogUrl(url: URL): string {
  const logged = new URL(url.toString());
  if (logged.searchParams.has("token")) {
    logged.searchParams.set("token", "<redacted>");
  }
  const parts = logged.pathname.split("/");
  if (parts[1] === "devices" && parts.length >= 3 && parts[2]) {
    parts[2] = "<redacted>";
    logged.pathname = parts.join("/");
  }
  return `${logged.pathname}${logged.search}`;
}


function isDeviceForegrounded(deviceToken: string): boolean {
  return deviceActive.get(deviceToken) ?? true;
}

function setDeviceActive(deviceToken: string, active: boolean): void {
  deviceActive.set(deviceToken, active);
  console.log(`[push] device ${deviceToken.slice(0, 8)}… active=${active}`);
}

function setDeviceViewing(deviceToken: string, sessionId: string | null): void {
  deviceViewing.set(deviceToken, sessionId);
  console.log(`[push] device ${deviceToken.slice(0, 8)}… viewing=${sessionId ?? "(none)"}`);
}

function subscribePush(sessionId: string, deviceToken: string): void {
  let set = pushSubscriptions.get(sessionId);
  if (!set) {
    set = new Set();
    pushSubscriptions.set(sessionId, set);
  }
  set.add(deviceToken);
  console.log(`[push] subscribed session=${sessionId} token=${deviceToken.slice(0, 8)}… count=${set.size}`);
}

function unsubscribePush(sessionId: string, deviceToken: string): void {
  const set = pushSubscriptions.get(sessionId);
  if (!set) return;
  set.delete(deviceToken);
  if (set.size === 0) pushSubscriptions.delete(sessionId);
  console.log(`[push] unsubscribed session=${sessionId} token=${deviceToken.slice(0, 8)}…`);
}

if (apns) {
  manager.addGlobalListener((event, session) => {
    if (event.type !== "agent_end") return;
    const tokens = pushSubscriptions.get(session.id);
    if (!tokens || tokens.size === 0) return;
    // Only suppress pushes when the user is foregrounded AND looking
    // at THIS exact session. If they're in another chat, on the
    // session list, or backgrounded, we still want a banner so they
    // know this session finished.
    const targets = [...tokens].filter((token) => {
      const active = isDeviceForegrounded(token);
      const viewing = deviceViewing.get(token) ?? null;
      return !(active && viewing === session.id);
    });
    if (targets.length === 0) {
      console.log(`[push] all ${tokens.size} subscribers are viewing session=${session.id}, skipping`);
      return;
    }
    const title = session.name ?? "pi reply";
    const body = extractAssistantTail(event) ?? "Reply ready";
    apns.sendMany(targets, {
      title,
      body,
      // Both ids let the iOS deep-link try the live session first and
      // fall back to opening the on-disk jsonl if the bridge has been
      // restarted in the meantime.
      custom: {
        sessionId: session.id,
        sessionPath: session.sessionPath ?? null,
      },
    }).then((results) => {
      for (const { token, result } of results) {
        if (!result.ok && (result.reason === "BadDeviceToken" || result.reason === "Unregistered")) {
          tokens.delete(token);
          console.log(`[push] pruned stale token session=${session.id} reason=${result.reason}`);
        }
      }
    }).catch((err) => {
      console.error("[push] sendMany failed:", err?.message ?? err);
    });
  });
}

/**
 * Best-effort extraction of the final assistant text from an `agent_end`
 * event so the push body shows the reply preview. Falls back to a
 * generic message when no text is found (e.g. tool-only turn).
 */
function extractAssistantTail(event: AgentEvent): string | undefined {
  const messages = (event as any).messages;
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    const content = m.content;
    if (typeof content === "string" && content.trim()) return content.trim().slice(0, 240);
    if (Array.isArray(content)) {
      for (let j = content.length - 1; j >= 0; j--) {
        const part = content[j];
        if (part && part.type === "text" && typeof part.text === "string" && part.text.trim()) {
          return part.text.trim().slice(0, 240);
        }
      }
    }
  }
  return undefined;
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const MAX_JSON_BODY_BYTES = 512 * 1024;
const MAX_TEXT_FIELD_LENGTH = 16_384;
const MAX_NAME_LENGTH = 128;
const MAX_DEVICE_TOKEN_LENGTH = 256;
const MAX_IMAGES = 8;
const MAX_IMAGE_DATA_LENGTH = 8 * 1024 * 1024;
async function readJsonObject(req: Request, maxBytes = MAX_JSON_BODY_BYTES): Promise<Record<string, unknown> | Response> {
  const contentLength = req.headers.get("content-length");
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      return json({ error: "request body too large" }, 413);
    }
  }
  const body = await req.text();
  if (Buffer.byteLength(body, "utf8") > maxBytes) {
    return json({ error: "request body too large" }, 413);
  }
  if (!body.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return json({ error: "JSON object required" }, 400);
  }
  return parsed as Record<string, unknown>;
}

function readBooleanField(body: Record<string, unknown>, key: string): boolean | Response {
  const value = body[key];
  if (typeof value !== "boolean") {
    return json({ error: `${key} must be a boolean` }, 400);
  }
  return value;
}

function readStringField(
  body: Record<string, unknown>,
  key: string,
  opts: { required?: boolean; maxLength?: number; allowEmpty?: boolean } = {},
): string | undefined | Response {
  const value = body[key];
  if (value === undefined || value === null) {
    return opts.required ? json({ error: `${key} is required` }, 400) : undefined;
  }
  if (typeof value !== "string") {
    return json({ error: `${key} must be a string` }, 400);
  }
  if (!opts.allowEmpty && value.length === 0 && opts.required) {
    return json({ error: `${key} cannot be empty` }, 400);
  }
  if (opts.maxLength !== undefined && value.length > opts.maxLength) {
    return json({ error: `${key} is too long` }, 413);
  }
  return value;
}

function validateImages(input: unknown): Array<{ type: "image"; data: string; mimeType: string }> | Response {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    return json({ error: "images must be an array" }, 400);
  }
  if (input.length > MAX_IMAGES) {
    return json({ error: `at most ${MAX_IMAGES} images allowed` }, 400);
  }
  const out: Array<{ type: "image"; data: string; mimeType: string }> = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") {
      return json({ error: "each image must be an object" }, 400);
    }
    const r = raw as Record<string, unknown>;
    const data = typeof r.data === "string" ? r.data : undefined;
    const mimeType = typeof r.mimeType === "string"
      ? r.mimeType
      : typeof r.media_type === "string"
        ? r.media_type
        : undefined;
    if (!data || !mimeType) {
      return json({ error: "each image requires data and mimeType" }, 400);
    }
    if (data.length > MAX_IMAGE_DATA_LENGTH) {
      return json({ error: "image payload too large" }, 413);
    }
    out.push({ type: "image", data, mimeType });
  }
  return out;
}

function requireOptionalSessionId(
  body: Record<string, unknown>,
  key: string,
): string | null | Response {
  const value = body[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    return json({ error: `${key} must be a string or null` }, 400);
  }
  return value.length > 0 ? value : null;
}
function requireDeviceToken(body: Record<string, unknown>): string | Response {
  const value = readStringField(body, "deviceToken", { required: true, maxLength: MAX_DEVICE_TOKEN_LENGTH, allowEmpty: false });
  if (typeof value !== "string") {
    return value instanceof Response ? value : json({ error: "deviceToken is required" }, 400);
  }
  return value;
}

function requireModelLockField(
  body: Record<string, unknown>,
  key: "provider" | "modelId",
): string | Response {
  const value = readStringField(body, key, { required: true, maxLength: MAX_TEXT_FIELD_LENGTH, allowEmpty: false });
  if (typeof value !== "string") {
    return value instanceof Response ? value : json({ error: `${key} is required` }, 400);
  }
  return value;
}

function requireTextField(
  body: Record<string, unknown>,
  key: string,
  maxLength: number,
  required = false,
): string | undefined | Response {
  const value = readStringField(body, key, { required, maxLength, allowEmpty: true });
  if (required) {
    if (typeof value === "string") return value;
    return value instanceof Response ? value : json({ error: `${key} is required` }, 400);
  }
  return value;
}

function requireNameField(body: Record<string, unknown>): string | Response {
  const value = readStringField(body, "name", { required: true, maxLength: MAX_NAME_LENGTH, allowEmpty: true });
  if (typeof value !== "string") {
    return value instanceof Response ? value : json({ error: "name is required" }, 400);
  }
  return value;
}


function checkAuth(req: Request, url: URL): boolean {
  const header = req.headers.get("authorization");
  if (header === `Bearer ${TOKEN}`) return true;
  // WebSocket upgrade can't easily set headers in JS on iOS; allow ?token= too.
  const q = url.searchParams.get("token");
  if (q && q === TOKEN) return true;
  return false;
}

function buildHealthSnapshot(): Record<string, unknown> {
  return {
    ok: true,
    cli: CLI,
    sessions: manager.list().length,
    sessionsRoot: SESSIONS_ROOT,
    apnsConfigured: !!apns,
  };
}


interface WsData {
  sessionId: string;
  sinceSeq?: number;
  unsubscribe: () => void;
}

const server = Bun.serve<WsData>({
  hostname: HOST,
  port: PORT,
  idleTimeout: 255,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const reqId = Math.random().toString(36).slice(2, 8);
    console.log(`[http #${reqId}] ${req.method} ${formatRequestLogUrl(url)}`);

    // Public: health check (lets the iOS Settings screen verify reachability
    // before a token is entered).
    if (url.pathname === "/health") {
      return json(buildHealthSnapshot());

    }

    if (!checkAuth(req, url)) {
      console.log(`[http #${reqId}] 401 unauthorized`);
      return unauthorized();
    }

    // WebSocket upgrade: /sessions/:id/events?sinceSeq=N
    const wsMatch = url.pathname.match(/^\/sessions\/([^/]+)\/events$/);
    if (wsMatch && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const sessionId = wsMatch[1]!;
      const session = manager.get(sessionId);
      if (!session) return json({ error: "session not found" }, 404);
      const sinceSeqRaw = url.searchParams.get("sinceSeq");
      const sinceSeq = sinceSeqRaw !== null ? Number.parseInt(sinceSeqRaw, 10) : undefined;
      const upgraded = srv.upgrade(req, {
        data: {
          sessionId,
          sinceSeq: Number.isFinite(sinceSeq as number) ? (sinceSeq as number) : undefined,
          unsubscribe: () => {},
        },
      });
      if (upgraded) return undefined as unknown as Response;
      return json({ error: "websocket upgrade failed" }, 500);
    }

    try {
      const res = await route(req, url);
      console.log(`[http #${reqId}] -> ${res.status}`);
      return res;
    } catch (err: any) {
      console.error(`[http #${reqId}] route error:`, err?.message ?? err);
      return json({ error: String(err?.message ?? err) }, 500);
    }
  },
  websocket: {
    open(ws) {
      const session = manager.get(ws.data.sessionId);
      if (!session) {
        ws.close(1011, "session not found");
        return;
      }
      // Replay events from the ring buffer. If the client passed
      // `?sinceSeq=N`, only replay newer events. If the buffer no longer
      // contains events at or just past N (ring overflowed), emit a
      // `resync_required` sentinel so the client can do a full reload
      // rather than stitch from an incomplete event stream.
      const sinceSeq = ws.data.sinceSeq;
      const buffer = session.recentEvents;
      const oldestSeq = buffer.length > 0 ? (buffer[0] as AgentEvent).seq ?? 0 : 0;
      if (sinceSeq !== undefined && buffer.length > 0 && oldestSeq > sinceSeq + 1) {
        try {
          ws.send(JSON.stringify({
            type: "resync_required",
            sinceSeq,
            oldestSeq,
            reason: "ring buffer gap",
          }));
        } catch {}
      }
      for (const e of buffer) {
        if (sinceSeq !== undefined && (e.seq ?? 0) <= sinceSeq) continue;
        ws.send(JSON.stringify(e));
      }
      const fn = (e: AgentEvent) => {
        try {
          ws.send(JSON.stringify(e));
        } catch {}
      };
      session.subscribers.add(fn);
      ws.data.unsubscribe = () => session.subscribers.delete(fn);
    },
    message(ws, msg) {
      // Currently no inbound WS messages; prompts go via HTTP POST.
      // Echo a heartbeat if client pings.
      if (typeof msg === "string" && msg === "ping") {
        ws.send("pong");
      }
    },
    close(ws) {
      ws.data.unsubscribe?.();
    },
  },
});

console.log(`pi-bridge listening on http://${HOST}:${PORT}`);
console.log(`  PI_CLI=${CLI}`);
console.log(`  sessionsRoot=${SESSIONS_ROOT}`);
console.log(`  apnsConfigured=${apns ? "yes" : "no"}`);
console.log(`  auth: Bearer ${TOKEN.slice(0, 4)}…${TOKEN.slice(-4)}`);

async function route(req: Request, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = req.method;

  if (path === "/health") {
    return json(buildHealthSnapshot());

  }

  // Sessions
  if (path === "/sessions" && method === "GET") {
    const onDisk = await listSessions();
    const live = manager.list();
    return json({ onDisk, live });
  }

  // Devices: per-device foreground/background state used to gate APNs
  // pushes. The token in the URL is the APNs device token; we don't
  // expose any per-device GET endpoint because we don't keep history.
  const devActiveMatch = path.match(/^\/devices\/([^/]+)\/active$/);
  if (devActiveMatch && method === "POST") {
    const deviceToken = devActiveMatch[1]!;
    const bodyOrResponse = await readJsonObject(req);
    if (bodyOrResponse instanceof Response) return bodyOrResponse;
    const active = readBooleanField(bodyOrResponse, "active");
    if (active instanceof Response) return active;
    setDeviceActive(deviceToken, active);
    return json({ ok: true, active });
  }

  const devViewingMatch = path.match(/^\/devices\/([^/]+)\/viewing$/);
  if (devViewingMatch && method === "POST") {
    const deviceToken = devViewingMatch[1]!;
    const bodyOrResponse = await readJsonObject(req);
    if (bodyOrResponse instanceof Response) return bodyOrResponse;
    const sessionId = requireOptionalSessionId(bodyOrResponse, "sessionId");
    if (sessionId instanceof Response) return sessionId;
    setDeviceViewing(deviceToken, sessionId);
    return json({ ok: true, sessionId });
  }

  if (path === "/sessions" && method === "POST") {
    const bodyOrResponse = await readJsonObject(req);
    if (bodyOrResponse instanceof Response) return bodyOrResponse;
    const cwdRaw = readStringField(bodyOrResponse, "cwd", { required: false, maxLength: 4096, allowEmpty: true });
    if (cwdRaw instanceof Response) return cwdRaw;
    const modelRaw = readStringField(bodyOrResponse, "model", { required: false, maxLength: MAX_TEXT_FIELD_LENGTH, allowEmpty: true });
    if (modelRaw instanceof Response) return modelRaw;
    const providerRaw = readStringField(bodyOrResponse, "provider", { required: false, maxLength: MAX_TEXT_FIELD_LENGTH, allowEmpty: true });
    if (providerRaw instanceof Response) return providerRaw;
    const resumeRaw = readStringField(bodyOrResponse, "resumeSessionPath", { required: false, maxLength: 4096, allowEmpty: true });
    if (resumeRaw instanceof Response) return resumeRaw;
    const cwd = typeof cwdRaw === "string" && cwdRaw.length > 0 ? cwdRaw : process.cwd();
    const model = typeof modelRaw === "string" && modelRaw.length > 0 ? modelRaw : undefined;
    const provider = typeof providerRaw === "string" && providerRaw.length > 0 ? providerRaw : undefined;
    const resumeSessionPath = typeof resumeRaw === "string" && resumeRaw.length > 0 ? resumeRaw : undefined;
    const s = await manager.create({ cwd, model, provider, resumeSessionPath });
    // Fetch initial state so the client has something to render.
    let state: unknown = null;
    try {
      const r = await s.rpc.send({ type: "get_state" });
      if (r.success) state = r.data;
    } catch {}
    return json({ id: s.id, cwd: s.cwd, state, keepAlive: s.keepAlive });
  }

  const m = path.match(/^\/sessions\/([^/]+)(?:\/(.*))?$/);
  if (m) {
    const id = m[1]!;
    const sub = m[2];
    const session = manager.get(id);
    if (!session) return json({ error: "session not found" }, 404);

    if (!sub && method === "DELETE") {
      await manager.destroy(id);
      return json({ ok: true });
    }

    if (sub === "messages" && method === "GET") {
      const r = await session.rpc.send({ type: "get_messages" });
      // Inject latestSeq so the client can fast-forward its lastSeenSeq
      // before opening the WS, preventing the ring buffer replay from
      // appending duplicates of messages already in this snapshot.
      const latestSeq = session.nextSeq;
      if (r && typeof r === "object" && r.success && r.data && typeof r.data === "object") {
        (r.data as Record<string, unknown>).latestSeq = latestSeq;
      }
      return json(r);
    }

    if (sub === "state" && method === "GET") {
      const r = await session.rpc.send({ type: "get_state" });
      return json(r);
    }

    if (sub === "stats" && method === "GET") {
      const r = await session.rpc.send({ type: "get_session_stats" });
      return json(r);
    }

    if (sub === "models" && method === "GET") {
      const r = await session.rpc.send({ type: "get_available_models" });
      // Test-container override: when PI_FORCE_PROVIDER / PI_FORCE_MODEL
      // are set, hide every other model from the iOS client so the picker
      // only shows the configured pair. The bridge already locks the
      // spawn args; this just keeps the UI honest.
      const fp = process.env.PI_FORCE_PROVIDER?.trim();
      const fm = process.env.PI_FORCE_MODEL?.trim();
      if ((fp || fm) && r && typeof r === "object" && r.success && r.data && typeof r.data === "object") {
        const data = r.data as { models?: Array<{ id?: string; provider?: string }> };
        if (Array.isArray(data.models)) {
          const before = data.models.length;
          data.models = data.models.filter((m) =>
            (!fp || m.provider === fp) && (!fm || m.id === fm),
          );
          console.log(`[forced-models] filtered ${before} -> ${data.models.length} (provider=${fp ?? "*"} model=${fm ?? "*"})`);
        }
      }
      return json(r);
    }

    if (sub === "prompt" && method === "POST") {
      const bodyOrResponse = await readJsonObject(req);
      if (bodyOrResponse instanceof Response) return bodyOrResponse;
      const messageRaw = requireTextField(bodyOrResponse, "message", MAX_TEXT_FIELD_LENGTH);
      if (messageRaw instanceof Response) return messageRaw;
      const images = validateImages(bodyOrResponse.images);
      if (images instanceof Response) return images;
      const message = typeof messageRaw === "string" ? messageRaw : "";
      if (!message && images.length === 0) return json({ error: "message or images required" }, 400);
      const r = await session.rpc.send({ type: "prompt", message, images });
      return json(r);
    }

    if (sub === "steer" && method === "POST") {
      const bodyOrResponse = await readJsonObject(req);
      if (bodyOrResponse instanceof Response) return bodyOrResponse;
      const messageRaw = requireTextField(bodyOrResponse, "message", MAX_TEXT_FIELD_LENGTH);
      if (messageRaw instanceof Response) return messageRaw;
      const images = validateImages(bodyOrResponse.images);
      if (images instanceof Response) return images;
      const r = await session.rpc.send({
        type: "steer",
        message: typeof messageRaw === "string" ? messageRaw : "",
        images,
      });
      return json(r);
    }

    if (sub === "follow_up" && method === "POST") {
      const bodyOrResponse = await readJsonObject(req);
      if (bodyOrResponse instanceof Response) return bodyOrResponse;
      const messageRaw = requireTextField(bodyOrResponse, "message", MAX_TEXT_FIELD_LENGTH);
      if (messageRaw instanceof Response) return messageRaw;
      const images = validateImages(bodyOrResponse.images);
      if (images instanceof Response) return images;
      const r = await session.rpc.send({
        type: "follow_up",
        message: typeof messageRaw === "string" ? messageRaw : "",
        images,
      });
      return json(r);
    }

    if (sub === "abort" && method === "POST") {
      const r = await session.rpc.send({ type: "abort" });
      return json(r);
    }

    if (sub === "model" && method === "POST") {
      const bodyOrResponse = await readJsonObject(req);
      if (bodyOrResponse instanceof Response) return bodyOrResponse;
      const fp = process.env.PI_FORCE_PROVIDER?.trim();
      const fm = process.env.PI_FORCE_MODEL?.trim();
      const provider = requireModelLockField(bodyOrResponse, "provider");
      if (provider instanceof Response) return provider;
      const modelId = requireModelLockField(bodyOrResponse, "modelId");
      if (modelId instanceof Response) return modelId;
      // Test-container override: refuse model switches that don't match
      // the locked provider/model. We don't silently rewrite the call
      // because that would let the client think the switch succeeded.
      if (fp || fm) {
        const ok = (!fp || provider === fp) && (!fm || modelId === fm);
        if (!ok) {
          console.log(`[forced-models] reject set_model provider=${provider} modelId=${modelId} (locked to ${fp ?? "*"}/${fm ?? "*"})`);
          return json({
            success: false,
            error: `model is locked to ${fp ?? "*"}/${fm ?? "*"} on this bridge`,
            locked: { provider: fp, modelId: fm },
          }, 403);
        }
      }
      const r = await session.rpc.send({
        type: "set_model",
        provider,
        modelId,
      });
      return json(r);
    }

    if (sub === "thinking" && method === "POST") {
      const bodyOrResponse = await readJsonObject(req);
      if (bodyOrResponse instanceof Response) return bodyOrResponse;
      const levelRaw = requireTextField(bodyOrResponse, "level", 16, true);
      if (typeof levelRaw !== "string") return levelRaw ?? json({ error: "level is required" }, 400);
      const level = levelRaw.trim().toLowerCase();
      const allowed = ["off", "minimal", "low", "medium", "high", "xhigh"];
      if (!allowed.includes(level)) {
        return json({ error: `level must be one of ${allowed.join(", ")}` }, 400);
      }
      const r = await session.rpc.send({ type: "set_thinking_level", level });
      return json(r);
    }

    if (sub === "compact" && method === "POST") {
      const bodyOrResponse = await readJsonObject(req);
      if (bodyOrResponse instanceof Response) return bodyOrResponse;
      const customInstructionsRaw = requireTextField(bodyOrResponse, "customInstructions", MAX_TEXT_FIELD_LENGTH);
      if (customInstructionsRaw instanceof Response) return customInstructionsRaw;
      const customInstructions = typeof customInstructionsRaw === "string" && customInstructionsRaw.length > 0
        ? customInstructionsRaw
        : undefined;
      const r = await session.rpc.send({ type: "compact", customInstructions });
      return json(r);
    }

    if (sub === "keep-alive" && method === "POST") {
      const bodyOrResponse = await readJsonObject(req);
      if (bodyOrResponse instanceof Response) return bodyOrResponse;
      const enabled = readBooleanField(bodyOrResponse, "enabled");
      if (enabled instanceof Response) return enabled;
      const ok = manager.setKeepAlive(id, enabled);
      if (!ok) return json({ error: "session not found" }, 404);
      return json({ ok: true, keepAlive: enabled });
    }

    if (sub === "notifications/subscribe" && method === "POST") {
      const bodyOrResponse = await readJsonObject(req);
      if (bodyOrResponse instanceof Response) return bodyOrResponse;
      const deviceToken = requireDeviceToken(bodyOrResponse);
      if (deviceToken instanceof Response) return deviceToken;
      subscribePush(id, deviceToken);
      return json({ ok: true, apnsConfigured: !!apns });
    }

    if (sub === "notifications/subscribe" && method === "DELETE") {
      const bodyOrResponse = await readJsonObject(req);
      if (bodyOrResponse instanceof Response) return bodyOrResponse;
      const deviceToken = requireDeviceToken(bodyOrResponse);
      if (deviceToken instanceof Response) return deviceToken;
      unsubscribePush(id, deviceToken);
      return json({ ok: true });
    }

    if (sub === "name" && method === "POST") {
      const bodyOrResponse = await readJsonObject(req);
      if (bodyOrResponse instanceof Response) return bodyOrResponse;
      const name = requireNameField(bodyOrResponse);
      if (name instanceof Response) return name;
      const r = await session.rpc.send({ type: "set_session_name", name });
      return json(r);
    }
  }

  return json({ error: "not found", path }, 404);
}


