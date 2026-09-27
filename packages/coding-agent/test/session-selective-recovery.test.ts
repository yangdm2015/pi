import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { buildOffsetIndex } from "../src/core/session-offset-index.js";
import { SessionManager } from "../src/core/session-manager.js";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it("selectively resumes the same ID after an active append without parsing old or abandoned bodies", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-selective-")); dirs.push(cwd);
  const manager = SessionManager.create(cwd, cwd);
  const now = Date.now();
  manager.appendMessage({ role: "system", content: "system prompt", timestamp: now } as never);
  manager.appendMessage({ role: "user", content: `OLD-MARKER-${"x".repeat(400_000)}`, timestamp: now } as never);
  const kept = manager.appendMessage({ role: "user", content: "keep this", timestamp: now } as never);
  const compact = manager.appendCompaction("summary", kept, 100);
  manager.appendMessage({ role: "user", content: `ABANDONED-MARKER-${"y".repeat(400_000)}`, timestamp: now } as never);
  manager.branch(compact);
  manager.appendMessage({ role: "user", content: "live", timestamp: now } as never);
  const file = manager.getSessionFile()!;
  const originalSize = statSync(file).size;
  const originalId = manager.getSessionId();
  expect(buildOffsetIndex(file, [manager.getHeader()!, ...manager.getEntries()])).toBe(true);
  const expected = manager.buildSessionContext();
  const parse = JSON.parse;
  vi.spyOn(JSON, "parse").mockImplementation((text: string, ...args: unknown[]) => {
    if (typeof text === "string" && (text.includes("OLD-MARKER-") || text.includes("ABANDONED-MARKER-")))
      throw new Error("old unrelated body deserialized");
    return parse(text, ...(args as [any]));
  });
  const restored = SessionManager.open(file);
  expect(restored.getSessionId()).toBe(originalId);
  expect(restored.buildSessionContext()).toEqual(expected);
  expect(restored.getActiveDiskBytes()).toBeLessThan(originalSize);
  restored.appendMessage({ role: "user", content: "after indexed restart", timestamp: now } as never);
  const again = SessionManager.open(file);
  expect(again.getSessionId()).toBe(originalId);
  expect(again.getLeafId()).toBe(restored.getLeafId());
  expect(again.buildSessionContext()).toEqual(restored.buildSessionContext());

  // Loss of the auxiliary file is an allowed one-time full fallback, never a
  // reason to discard entries or modify the authoritative JSONL.
  vi.restoreAllMocks();
  const beforeRebuild = readFileSync(file);
  unlinkSync(`${file}.idx`);
  const fallback = SessionManager.open(file);
  expect(fallback.buildSessionContext()).toEqual(again.buildSessionContext());
  expect(readFileSync(file)).toEqual(beforeRebuild);
  expect(statSync(`${file}.idx`).isFile()).toBe(true);
  vi.spyOn(JSON, "parse").mockImplementation((text: string, ...args: unknown[]) => {
    if (typeof text === "string" && (text.includes("OLD-MARKER-") || text.includes("ABANDONED-MARKER-")))
      throw new Error("rebuilt index still loaded old body");
    return parse(text, ...(args as [any]));
  });
  expect(SessionManager.open(file).buildSessionContext()).toEqual(fallback.buildSessionContext());
});

it("a crash-length stale or corrupt index falls back to the authoritative JSONL once", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-torn-index-")); dirs.push(cwd);
  const manager = SessionManager.create(cwd, cwd);
  manager.appendMessage({ role: "user", content: "first", timestamp: Date.now() } as never);
  const file = manager.getSessionFile()!;
  const before = readFileSync(file);
  const lastId = manager.getLeafId();
  appendFileSync(file, `${JSON.stringify({ type: "message", id: "unindexed-last", parentId: lastId,
    timestamp: new Date().toISOString(), message: { role: "user", content: "after crash", timestamp: Date.now() } })}\n`);
  const recovered = SessionManager.open(file);
  expect(recovered.getLeafId()).toBe("unindexed-last");
  expect(recovered.buildSessionContext().messages.some(m => m.role === "user" && m.content === "after crash")).toBe(true);
  const sourceAfterRecovery = readFileSync(file);
  expect(sourceAfterRecovery.subarray(0, before.length)).toEqual(before);
  writeFileSync(`${file}.idx`, "{broken", { mode: 0o600 });
  const recoveredAgain = SessionManager.open(file);
  expect(recoveredAgain.getLeafId()).toBe("unindexed-last");
  expect(readFileSync(file)).toEqual(sourceAfterRecovery);
  expect(SessionManager.open(file).buildSessionContext()).toEqual(recoveredAgain.buildSessionContext());
});
