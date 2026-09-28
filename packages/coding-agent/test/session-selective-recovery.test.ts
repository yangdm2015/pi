import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";
import { buildOffsetIndex, readOffsetIndex } from "../src/core/session-offset-index.js";

const dirs: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("keeps normal indexed appends off the full historical index parse", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-cursor-"));
	dirs.push(cwd);
	const first = SessionManager.create(cwd, cwd);
	first.appendMessage({ role: "user", content: "start", timestamp: Date.now() } as never);
	first.appendSessionInfo("HISTORIC-INDEX-MARKER");
	const file = first.getSessionFile()!;
	const second = SessionManager.open(file);
	const originalParse = JSON.parse;
	const parseSpy = vi.spyOn(JSON, "parse").mockImplementation((text: string, ...args: unknown[]) => {
		if (typeof text === "string" && text.includes("HISTORIC-INDEX-MARKER"))
			throw new Error("re-parsed historical index or source");
		return originalParse(text, ...(args as [any]));
	});
	try {
		second.appendMessage({ role: "user", content: "new message", timestamp: Date.now() } as never);
	} finally {
		parseSpy.mockRestore();
	}
	expect(SessionManager.open(file).getLeafId()).toBe(second.getLeafId());
});

it("recovers a torn live journal from the authoritative source without dropping cold history", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-cursor-torn-"));
	dirs.push(cwd);
	const manager = SessionManager.create(cwd, cwd);
	manager.appendMessage({ role: "user", content: "old archived content", timestamp: Date.now() } as never);
	const file = manager.getSessionFile()!;
	const cold = SessionManager.open(file);
	const before = readFileSync(file);
	appendFileSync(`${file}.idx.delta`, "{torn");
	const latest = cold.appendMessage({ role: "user", content: "new turn", timestamp: Date.now() } as never);
	expect(readFileSync(file).subarray(0, before.length)).toEqual(before);
	const restarted = SessionManager.open(file);
	expect(restarted.getLeafId()).toBe(latest);
	expect(
		restarted
			.getEntries()
			.some(
				(e) => e.type === "message" && e.message.role === "user" && e.message.content === "old archived content",
			),
	).toBe(true);
});

it("handles two live managers sharing a file without skipping an interleaved record", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-cursor-interleave-"));
	dirs.push(cwd);
	const initial = SessionManager.create(cwd, cwd);
	initial.appendMessage({ role: "user", content: "root", timestamp: Date.now() } as never);
	const file = initial.getSessionFile()!;
	const first = SessionManager.open(file);
	const second = SessionManager.open(file);
	const one = first.appendMessage({ role: "user", content: "first writer", timestamp: Date.now() } as never);
	const two = second.appendMessage({ role: "user", content: "second writer", timestamp: Date.now() } as never);
	expect(
		readOffsetIndex(file)
			?.records.slice(-2)
			.map((r) => r.id),
	).toEqual([one, two]);
	const recovered = SessionManager.open(file);
	expect(recovered.getLeafId()).toBe(two);
	expect(recovered.getEntries().map((entry) => entry.id)).toEqual(expect.arrayContaining([one, two]));
});

it("continues authoritative appends when a valid session cannot be indexed", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-unsupported-index-"));
	dirs.push(cwd);
	const file = join(cwd, "oversized-header.jsonl");
	const header = {
		type: "session",
		version: 3,
		id: "large-header",
		cwd,
		timestamp: new Date().toISOString(),
		padding: "x".repeat(70_000),
	};
	const first = {
		type: "message",
		id: "first",
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: "first", timestamp: Date.now() },
	};
	writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(first)}\n`);
	const manager = SessionManager.open(file);
	const before = readFileSync(file);
	const next = manager.appendMessage({ role: "user", content: "second", timestamp: Date.now() } as never);
	expect(readFileSync(file).subarray(0, before.length)).toEqual(before);
	expect(SessionManager.open(file).getLeafId()).toBe(next);
	expect(readOffsetIndex(file)).toBeNull();
});

it("reloads a fully materialized manager when another writer leaves an unindexed source entry", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-external-unindexed-"));
	dirs.push(cwd);
	const manager = SessionManager.create(cwd, cwd);
	const firstId = manager.appendMessage({ role: "user", content: "first", timestamp: Date.now() } as never);
	const file = manager.getSessionFile()!;
	const external = {
		type: "message",
		id: "external-id",
		parentId: firstId,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: "external", timestamp: Date.now() },
	};
	appendFileSync(file, `${JSON.stringify(external)}\n`);
	const ownId = manager.appendMessage({ role: "user", content: "own", timestamp: Date.now() } as never);
	const recovered = SessionManager.open(file);
	expect(readOffsetIndex(file)?.records.map((r) => r.id)).toEqual(
		expect.arrayContaining([firstId, external.id, ownId]),
	);
	expect(recovered.getEntries().map((e) => e.id)).toEqual(expect.arrayContaining([firstId, external.id, ownId]));
});

it("selectively resumes the same ID after an active append without parsing old or abandoned bodies", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-selective-"));
	dirs.push(cwd);
	const manager = SessionManager.create(cwd, cwd);
	const now = Date.now();
	manager.appendMessage({ role: "system", content: "system prompt", timestamp: now } as never);
	manager.appendMessage({ role: "user", content: `OLD-MARKER-${"x".repeat(400_000)}`, timestamp: now } as never);
	const kept = manager.appendMessage({ role: "user", content: "keep this", timestamp: now } as never);
	const compact = manager.appendCompaction("summary", kept, 100);
	const abandonedId = manager.appendMessage({
		role: "user",
		content: `ABANDONED-MARKER-${"y".repeat(400_000)}`,
		timestamp: now,
	} as never);
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
	vi.restoreAllMocks();
	// An explicit historical lookup still returns the original, unmodified entry.
	const selected = SessionManager.open(file);
	expect(selected.getActiveEntries().some((e) => e.id === abandonedId)).toBe(false);
	const raw = selected.getEntry(abandonedId);
	expect(raw?.type).toBe("message");
	expect(raw?.type === "message" && raw.message.role === "user" && raw.message.content).toContain("ABANDONED-MARKER-");
	expect(selected.getLeafId()).toBe(again.getLeafId());
	expect(selected.getEntries()).toEqual(fallback.getEntries());
});

it("keeps a complete uncompacted active branch without parsing an abandoned sibling", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-no-compaction-"));
	dirs.push(cwd);
	const manager = SessionManager.create(cwd, cwd);
	const root = manager.appendMessage({ role: "user", content: "root", timestamp: Date.now() } as never);
	manager.appendMessage({
		role: "user",
		content: `SIBLING-MARKER-${"s".repeat(400_000)}`,
		timestamp: Date.now(),
	} as never);
	manager.branch(root);
	manager.appendMessage({ role: "user", content: "current", timestamp: Date.now() } as never);
	const expected = manager.buildSessionContext();
	const file = manager.getSessionFile()!;
	expect(buildOffsetIndex(file, [manager.getHeader()!, ...manager.getEntries()])).toBe(true);
	const parse = JSON.parse;
	vi.spyOn(JSON, "parse").mockImplementation((text: string, ...args: unknown[]) => {
		if (typeof text === "string" && text.includes("SIBLING-MARKER-")) throw new Error("parsed abandoned sibling");
		return parse(text, ...(args as [any]));
	});
	const recovered = SessionManager.open(file);
	expect(recovered.buildSessionContext()).toEqual(expected);
	expect(recovered.buildContextEntries().filter((entry) => entry.type === "message")).toHaveLength(2);
});

it("a crash-length stale or corrupt index falls back to the authoritative JSONL once", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-torn-index-"));
	dirs.push(cwd);
	const manager = SessionManager.create(cwd, cwd);
	manager.appendMessage({ role: "user", content: "first", timestamp: Date.now() } as never);
	const file = manager.getSessionFile()!;
	const before = readFileSync(file);
	const lastId = manager.getLeafId();
	appendFileSync(
		file,
		`${JSON.stringify({
			type: "message",
			id: "unindexed-last",
			parentId: lastId,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: "after crash", timestamp: Date.now() },
		})}\n`,
	);
	const recovered = SessionManager.open(file);
	expect(recovered.getLeafId()).toBe("unindexed-last");
	expect(recovered.buildSessionContext().messages.some((m) => m.role === "user" && m.content === "after crash")).toBe(
		true,
	);
	const sourceAfterRecovery = readFileSync(file);
	expect(sourceAfterRecovery.subarray(0, before.length)).toEqual(before);
	writeFileSync(`${file}.idx`, "{broken", { mode: 0o600 });
	const recoveredAgain = SessionManager.open(file);
	expect(recoveredAgain.getLeafId()).toBe("unindexed-last");
	expect(readFileSync(file)).toEqual(sourceAfterRecovery);
	expect(SessionManager.open(file).buildSessionContext()).toEqual(recoveredAgain.buildSessionContext());
});
