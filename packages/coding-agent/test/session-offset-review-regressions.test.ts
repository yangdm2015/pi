import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS, prepareCompaction } from "../src/core/compaction/compaction.js";
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

it("never selects an in-memory synthetic ID as a persisted compaction boundary", () => {
	const manager = session();
	const root = manager.appendMessage(message("A ".repeat(300)));
	manager.appendSessionInfo("off-branch title");
	manager.branch(root);
	const kept = manager.appendMessage(message("B ".repeat(300)));
	manager.appendCompaction("old summary", kept, 200);
	manager.appendMessage(message("C ".repeat(300)));
	const recovered = indexed(manager);
	const synthetic = recovered
		.getActiveBranch()
		.filter((e) => (e as typeof e & { __offsetSynthetic?: boolean }).__offsetSynthetic)
		.map((e) => e.id);
	expect(synthetic.length).toBeGreaterThan(0);
	let preparedCount = 0;
	for (const keepRecentTokens of [1, 10, 100, 400]) {
		const prepared = prepareCompaction(recovered.getActiveBranch(), {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens,
		});
		if (prepared) {
			preparedCount++;
			expect(synthetic).not.toContain(prepared.firstKeptEntryId);
		}
	}
	expect(preparedCount).toBeGreaterThan(0);
});

it("keeps explicit extension branch inspection able to restore pre-compaction custom state", () => {
	const manager = session();
	manager.appendMessage(message("root"));
	const state = manager.appendCustomEntry("todo-state", { list: ["persisted"] });
	const kept = manager.appendMessage(message("kept"));
	manager.appendCompaction("summary", kept, 100);
	const recovered = indexed(manager);
	expect(recovered.getActiveBranch().some((e) => e.id === state)).toBe(false);
	expect(recovered.getBranch().find((e) => e.id === state)).toMatchObject({
		type: "custom",
		data: { list: ["persisted"] },
	});
});

it("does not full-load old bodies to fetch a newly appended entry", () => {
	const manager = session();
	manager.appendMessage(message(`OLD-${"x".repeat(400000)}`));
	const kept = manager.appendMessage(message("kept"));
	manager.appendCompaction("summary", kept, 100);
	const recovered = indexed(manager);
	const latest = recovered.appendMessage(message("new"));
	const parse = JSON.parse;
	const spy = vi.spyOn(JSON, "parse").mockImplementation((text: string, ...args: unknown[]) => {
		if (typeof text === "string" && text.includes("OLD-")) throw new Error("unnecessary full history read");
		return parse(text, ...(args as [any]));
	});
	try {
		expect(recovered.getEntry(latest)?.id).toBe(latest);
	} finally {
		spy.mockRestore();
	}
});

it("preserves explicit thinking off and a cleared global title", () => {
	const manager = session();
	manager.appendMessage(message("root"));
	manager.appendSessionInfo("old title");
	manager.appendThinkingLevelChange("off");
	const kept = manager.appendMessage(message("kept"));
	manager.appendCompaction("summary", kept, 100);
	manager.appendSessionInfo("");
	const recovered = indexed(manager);
	expect(recovered.getSessionName()).toBeUndefined();
	expect(
		recovered.getActiveBranch().some((e) => e.type === "thinking_level_change" && e.thinkingLevel === "off"),
	).toBe(true);
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
