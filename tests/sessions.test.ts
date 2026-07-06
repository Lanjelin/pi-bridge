import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeCwd, listSessions } from "../sessions.ts";


const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
});

test("lists session metadata from a custom root", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-bridge-sessions-"));
  roots.push(root);
  const sessionDir = join(root, "work-project");
  await mkdir(sessionDir, { recursive: true });

  const file = join(sessionDir, "session.jsonl");
  await writeFile(file, [
    JSON.stringify({ type: "session", id: "sess-1", cwd: "", timestamp: "2026-07-06T00:00:00Z" }),
    JSON.stringify({ type: "session_name", name: "Daily Run" }),
    JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "Hello   world" }] } }),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", name: "search" },
          { type: "text", text: "Answer ready" },
        ],
      },
    }),
    "",
  ].join("\n"));

  const sessions = await listSessions(root);
  expect(sessions).toHaveLength(1);
  expect(sessions[0]).toMatchObject({
    sessionId: "sess-1",
    cwd: "work/project",
    sessionPath: file,
    name: "Daily Run",
    timestamp: "2026-07-06T00:00:00Z",
    messageCount: 2,
    lastUserText: "Hello world",
    lastMessageText: "Answer ready",
  });
  expect(decodeCwd("foo-bar-baz")).toBe("foo/bar/baz");
});

test("refreshes cached summaries when the file changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-bridge-sessions-"));
  roots.push(root);
  const sessionDir = join(root, "project-name");
  await mkdir(sessionDir, { recursive: true });

  const file = join(sessionDir, "session.jsonl");
  await writeFile(file, [
    JSON.stringify({ type: "session", id: "sess-2", cwd: "", timestamp: "2026-07-06T01:00:00Z" }),
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "First" }] } }),
    "",
  ].join("\n"));

  const first = await listSessions(root);
  expect(first[0]?.lastMessageText).toBe("First");

  await writeFile(file, [
    JSON.stringify({ type: "session", id: "sess-2", cwd: "", timestamp: "2026-07-06T01:00:00Z" }),
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Updated" }] } }),
    "",
  ].join("\n"));
  await utimes(file, new Date(), new Date(Date.now() + 1000));

  const second = await listSessions(root);
  expect(second[0]?.lastMessageText).toBe("Updated");
});
