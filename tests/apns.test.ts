import { expect, test } from "bun:test";
import { parseRetryAfterHeader } from "../apns.ts";

test("parses Retry-After seconds", () => {
  expect(parseRetryAfterHeader("10", 1_000)).toBe(10_000);
  expect(parseRetryAfterHeader("0", 1_000)).toBe(0);
});

test("parses Retry-After dates", () => {
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);
  const future = new Date(now + 5_000).toUTCString();
  expect(parseRetryAfterHeader(future, now)).toBe(5_000);
});

test("ignores invalid Retry-After headers", () => {
  expect(parseRetryAfterHeader("not-a-date", 1_000)).toBeUndefined();
  expect(parseRetryAfterHeader(undefined, 1_000)).toBeUndefined();
});
