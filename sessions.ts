// Scan the configured Pi sessions directory (default: ~/.pi/agent/sessions)
//
// Newer pi sessions store messages as:
//   {"type":"message","message":{"role":"user|assistant","content":[...]}}
// Older sessions may still use user_message / assistant_message records.

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionSummary } from "./types.ts";

export const SESSIONS_ROOT = (() => {
  const configured = process.env.PI_SESSIONS_ROOT?.trim();
  if (!configured) {
    return join(homedir(), ".pi", "agent", "sessions");
  }
  if (configured.startsWith("~/")) {
    return join(homedir(), configured.slice(2));
  }
  return configured;
})();

const sessionSummaryCache = new Map<string, { mtime: number; summary: SessionSummary }>();


export function decodeCwd(encoded: string): string {
  return encoded.replace(/-/g, "/");
}

interface SessionMeta {
  id: string;
  cwd: string;
  timestamp: string;
  name?: string;
  messageCount: number;
  lastUserText?: string;
  lastMessageText?: string;
}

function normalizePreview(text: string): string | undefined {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}

function extractPreview(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizePreview(value);
  }

  if (Array.isArray(value)) {
    const textParts: string[] = [];
    const toolNames: string[] = [];

    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const type = record["type"];

      if (type === "text") {
        const text = extractPreview(record["text"]);
        if (text) textParts.push(text);
        continue;
      }

      if (type === "toolCall") {
        const name = record["name"];
        if (typeof name === "string" && name.length > 0) {
          toolNames.push(name);
        }
      }
    }

    if (textParts.length > 0) {
      return normalizePreview(textParts.join(" "));
    }

    if (toolNames.length > 0) {
      return normalizePreview(`Tool call: ${toolNames.join(", ")}`);
    }

    return undefined;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  return extractPreview(record["content"]) ?? extractPreview(record["text"]);
}

async function readSessionMeta(path: string): Promise<SessionMeta | null> {
  try {
    const buf = await readFile(path, "utf8");
    const lines = buf.split("\n").filter((line) => line.length > 0);
    if (lines.length === 0) return null;

    let id = "";
    let cwd = "";
    let timestamp = "";
    let name: string | undefined;
    let messageCount = 0;
    let lastUserText: string | undefined;
    let lastMessageText: string | undefined;

    for (const line of lines) {
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }

      const type = rec["type"];
      if (type === "session") {
        id = String(rec["id"] ?? "");
        cwd = String(rec["cwd"] ?? "");
        timestamp = String(rec["timestamp"] ?? "");
        continue;
      }

      if (type === "session_name") {
        const nextName = rec["name"];
        if (typeof nextName === "string" && nextName.length > 0) {
          name = nextName;
        }
        continue;
      }

      if (type === "message") {
        const message = rec["message"];
        if (!message || typeof message !== "object") continue;
        const msg = message as Record<string, unknown>;
        const role = msg["role"];
        if (role !== "user" && role !== "assistant") continue;

        messageCount++;
        const preview = extractPreview(msg);
        if (role === "assistant" && preview) lastMessageText = preview;
        if (role === "user" && preview) lastUserText = preview;
        continue;
      }

      if (type === "user_message" || type === "user") {
        messageCount++;
        const preview = extractPreview(rec);
        if (preview) {
          lastUserText = preview;
        }
        continue;
      }

      if (type === "assistant_message" || type === "assistant") {
        messageCount++;
        const preview = extractPreview(rec);
        if (preview) lastMessageText = preview;
      }
    }

    if (!id) return null;
    return { id, cwd, timestamp, name, messageCount, lastUserText, lastMessageText };
  } catch {
    return null;
  }
}

export async function listSessions(root = SESSIONS_ROOT): Promise<SessionSummary[]> {
  let dirs: string[] = [];
  try {
    dirs = await readdir(root);
  } catch {
    return [];
  }

  const out: SessionSummary[] = [];

  for (const dir of dirs) {
    const cwdDir = join(root, dir);
    let files: string[] = [];
    try {
      files = await readdir(cwdDir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const full = join(cwdDir, file);

      let mtime = 0;
      try {
        const fileStat = await stat(full);
        mtime = fileStat.mtimeMs;
      } catch {
        continue;
      }

      const cached = sessionSummaryCache.get(full);
      if (cached && cached.mtime === mtime) {
        out.push(cached.summary);
        continue;
      }

      const meta = await readSessionMeta(full);
      if (!meta) continue;

      const summary: SessionSummary = {
        sessionId: meta.id,
        cwd: meta.cwd || decodeCwd(dir),
        sessionPath: full,
        name: meta.name,
        timestamp: meta.timestamp,
        mtime,
        messageCount: meta.messageCount,
        lastUserText: meta.lastUserText,
        lastMessageText: meta.lastMessageText,
      };
      sessionSummaryCache.set(full, { mtime, summary });
      out.push(summary);
    }
  }

  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}
