import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";
import { buildOffsetIndex } from "../src/core/session-offset-index.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function session() {
	const dir = mkdtempSync(join(tmpdir(), "pi-index-review-"));
	dirs.push(dir);
	return SessionManager.create(dir, dir);
}
function indexed(manager: SessionManager): SessionManager {
	const file = manager.getSessionFile()!;
	expect(buildOffsetIndex(file, [manager.getHeader()!, ...manager.getEntries()])).toBe(true);
	return SessionManager.open(file);
}
const message = (content: string) => ({ role: "user", content, timestamp: Date.now() }) as never;
const assistant = (cacheRead: number) =>
	({
		role: "assistant",
		provider: "test",
		model: "test",
		content: [{ type: "text", text: "ok" }],
		timestamp: Date.now(),
		stopReason: "stop",
		usage: {
			input: 5,
			cacheRead,
			cacheWrite: 0,
			output: 3,
			totalTokens: 8 + cacheRead,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	}) as never;

it("reopens and forks a new session without loading from the new, nonexistent file", () => {
	const manager = session();
	const original = manager.appendMessage(message("root"));
	manager.appendMessage(message("later"));
	const restored = indexed(manager);
	const branchPath = restored.createBranchedSession(original)!;
	const newSession = SessionManager.open(branchPath);
	expect(newSession.getSessionId()).not.toBe(manager.getSessionId());
	expect(newSession.getBranch().filter((e) => e.type === "message")).toHaveLength(1);
	expect(newSession.buildSessionContext().messages[0]).toMatchObject({ role: "user", content: "root" });
});

it("restores original ancestry before branching to a retained pre-compaction entry", () => {
	const manager = session();
	const a = manager.appendMessage(message("A"));
	const b = manager.appendMessage(message("B"));
	manager.appendCompaction("summary", b, 123);
	const recovered = indexed(manager);
	recovered.branch(b);
	expect(recovered.getBranch().map((e) => e.id)).toEqual([a, b]);
	expect(
		recovered
			.buildSessionContext()
			.messages.filter((m) => m.role === "user")
			.map((m) => m.content),
	).toEqual(["A", "B"]);
});

it("keeps the physical latest assistant cache-hit rate after compaction and subsequent appends", () => {
	const manager = session();
	manager.appendMessage(message("root"));
	manager.appendMessage(assistant(5));
	const kept = manager.appendMessage(message("kept"));
	manager.appendCompaction("summary", kept, 123);
	const expected = manager.getUsageSnapshot();
	const recovered = indexed(manager);
	expect(recovered.getUsageSnapshot()).toEqual(expected);
	recovered.appendMessage(assistant(15));
	expect(recovered.getUsageSnapshot()).toEqual(SessionManager.open(recovered.getSessionFile()!).getUsageSnapshot());
	expect(recovered.getUsageSnapshot().latestCacheHitRate).toBe(75);
});

it("preserves a globally latest session title on an uncompacted abandoned branch", () => {
	const manager = session();
	const root = manager.appendMessage(message("root"));
	manager.appendSessionInfo("Title");
	manager.branch(root);
	manager.appendMessage(message("selected"));
	expect(indexed(manager).getSessionName()).toBe(manager.getSessionName());
	expect(manager.getSessionName()).toBe("Title");
});
