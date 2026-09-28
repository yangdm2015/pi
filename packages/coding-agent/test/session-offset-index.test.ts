import {
	appendFileSync,
	chmodSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSessionContext, type FileEntry, SessionManager } from "../src/core/session-manager.js";
import {
	appendOffsetIndexWithCursor,
	buildOffsetIndex,
	createOffsetIndexAppendCursor,
	loadIndexedActiveSession,
	readOffsetIndex,
} from "../src/core/session-offset-index.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "pi-offset-index-"));
	dirs.push(dir);
	const file = join(dir, "session.jsonl");
	const header = {
		type: "session",
		version: 3,
		id: "session-a",
		cwd: dir,
		timestamp: "2026-09-27T00:00:00Z",
	} as FileEntry;
	const first = {
		type: "message",
		id: "msg-1",
		parentId: null,
		timestamp: "2026-09-27T00:00:01Z",
		message: { role: "user", content: "A".repeat(256 * 1024), timestamp: 1 },
	} as FileEntry;
	const other = {
		type: "message",
		id: "msg-2",
		parentId: "msg-1",
		timestamp: "2026-09-27T00:00:02Z",
		message: { role: "user", content: "B", timestamp: 2 },
	} as FileEntry;
	const entries = [header, first, other];
	writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
	return { dir, file, entries };
}

describe("session offset metadata index", () => {
	it("uses a verified cursor without re-parsing historical index metadata on each append", () => {
		const { file, entries } = fixture();
		expect(buildOffsetIndex(file, entries)).toBe(true);
		const cursor = createOffsetIndexAppendCursor(file, readOffsetIndex(file)!);
		expect(cursor).not.toBeNull();
		const originalParse = JSON.parse;
		const spy = vi.spyOn(JSON, "parse").mockImplementation((text: string, ...args: unknown[]) => {
			if (typeof text === "string" && text.includes('"records":['))
				throw new Error("re-parsed whole historical index");
			return originalParse(text, ...(args as [any]));
		});
		try {
			for (let i = 0; i < 3; i++) {
				const entry = {
					type: "message",
					id: `new-${i}`,
					parentId: i ? `new-${i - 1}` : "msg-2",
					timestamp: "2026-09-27T00:00:03Z",
					message: { role: "user", content: `new ${i}`, timestamp: 3 + i },
				} as FileEntry;
				appendFileSync(file, `${JSON.stringify(entry)}\n`);
				expect(appendOffsetIndexWithCursor(file, entry as never, cursor!)).toBe(true);
			}
		} finally {
			spy.mockRestore();
		}
		expect(
			readOffsetIndex(file)
				?.records.slice(-3)
				.map((record) => record.id),
		).toEqual(["new-0", "new-1", "new-2"]);
	});

	it("rejects an archived ID collision without writing index metadata", () => {
		const { file, entries } = fixture();
		expect(buildOffsetIndex(file, entries)).toBe(true);
		const cursor = createOffsetIndexAppendCursor(file, readOffsetIndex(file)!)!;
		const sameId = { ...entries[2], parentId: "msg-2" } as FileEntry;
		appendFileSync(file, `${JSON.stringify(sameId)}\n`);
		expect(appendOffsetIndexWithCursor(file, sameId as never, cursor)).toBe(false);
		expect(cursor.ids.has("msg-2")).toBe(true);
		expect(readOffsetIndex(file)).toBeNull();
	});

	it("rejects sidecar replacement and external source append with a cached cursor", () => {
		const { file, entries } = fixture();
		expect(buildOffsetIndex(file, entries)).toBe(true);
		const cursor = createOffsetIndexAppendCursor(file, readOffsetIndex(file)!);
		expect(cursor).not.toBeNull();
		const replacement = `${file}.idx.bak`;
		renameSync(`${file}.idx`, replacement);
		writeFileSync(`${file}.idx`, readFileSync(replacement), { mode: 0o600 });
		const next = { ...entries[2], id: "new-1", parentId: "msg-2" } as FileEntry;
		appendFileSync(file, `${JSON.stringify(next)}\n`);
		expect(appendOffsetIndexWithCursor(file, next as never, cursor!)).toBe(false);
		expect(readOffsetIndex(file)).toBeNull();
	});

	it("records byte-exact ranges without storing old message bodies", () => {
		const { file, entries } = fixture();
		expect(buildOffsetIndex(file, entries)).toBe(true);
		const index = readOffsetIndex(file);
		expect(index?.id).toBe("session-a");
		expect(index?.records.map((r) => [r.id, r.parentId, r.type])).toEqual([
			["msg-1", null, "message"],
			["msg-2", "msg-1", "message"],
		]);
		expect(index?.records[0]?.start).toBe(Buffer.byteLength(`${JSON.stringify(entries[0])}\n`));
		expect(index?.records.at(-1)?.end).toBe(statSync(file).size);
		expect(readFileSync(`${file}.idx`, "utf8")).not.toContain("A".repeat(128));
		expect(statSync(`${file}.idx`).mode & 0o077).toBe(0);
	});
	it("fails closed to the caller on wrong identity, stale source, corrupt index, or symlink", () => {
		const { file, entries } = fixture();
		expect(buildOffsetIndex(file, entries)).toBe(true);
		const index = readOffsetIndex(file)!;
		writeFileSync(`${file}.idx`, JSON.stringify({ ...index, id: "wrong-id" }), { mode: 0o600 });
		expect(readOffsetIndex(file)).toBeNull();
		expect(buildOffsetIndex(file, entries)).toBe(true);
		writeFileSync(file, `${readFileSync(file, "utf8")}\n`);
		expect(readOffsetIndex(file)).toBeNull();
		writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
		expect(buildOffsetIndex(file, entries)).toBe(true);
		chmodSync(`${file}.idx`, 0o644);
		expect(readOffsetIndex(file)).toBeNull();
		chmodSync(`${file}.idx`, 0o600);
		const copy = `${file}.index-copy`;
		renameSync(`${file}.idx`, copy);
		symlinkSync(copy, `${file}.idx`);
		expect(readOffsetIndex(file)).toBeNull();
	});
	it("loads only the current compacted branch, not large abandoned bodies", () => {
		const { dir } = fixture();
		const manager = SessionManager.create(dir, dir);
		const now = Date.now();
		manager.appendMessage({ role: "system", content: "system prompt", timestamp: now } as never);
		manager.appendModelChange("test", "model");
		manager.appendMessage({ role: "user", content: `OLD-BODY-${"x".repeat(512 * 1024)}`, timestamp: now } as never);
		manager.appendMessage({
			role: "assistant",
			provider: "test",
			model: "model",
			content: [{ type: "text", text: "old" }],
			stopReason: "stop",
			timestamp: now,
			usage: {
				input: 10,
				output: 2,
				cacheRead: 3,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
			},
		} as never);
		const kept = manager.appendMessage({ role: "user", content: "kept", timestamp: now } as never);
		const compaction = manager.appendCompaction("summary", kept, 100);
		manager.appendMessage({
			role: "user",
			content: `OTHER-BRANCH-${"y".repeat(512 * 1024)}`,
			timestamp: now,
		} as never);
		manager.appendLabelChange(kept, "bookmark");
		manager.branch(compaction);
		const active = manager.appendMessage({ role: "user", content: "selected", timestamp: now } as never);
		const file = manager.getSessionFile()!;
		const expected = manager.buildSessionContext();
		expect(buildOffsetIndex(file, [manager.getHeader()!, ...manager.getEntries()])).toBe(true);
		const parse = JSON.parse;
		const spy = vi.spyOn(JSON, "parse").mockImplementation((text: string, ...args: unknown[]) => {
			if (typeof text === "string" && (text.includes("OLD-BODY-") || text.includes("OTHER-BRANCH-")))
				throw new Error("parsed unneeded body");
			return parse(text, ...(args as [any]));
		});
		try {
			const result = loadIndexedActiveSession(file, readOffsetIndex(file)!);
			expect(result).not.toBeNull();
			const loaded = result!.entries.filter((e) => e.type !== "session");
			expect(loaded.at(-1)?.id).toBe(active);
			expect(loaded.some((e) => e.type === "compaction" && e.id === compaction)).toBe(true);
			expect(
				loaded.some((e) => e.type === "message" && e.message.role === "user" && e.message.content === "kept"),
			).toBe(true);
			expect(
				loaded.some((e) => e.type === "message" && e.message.role === "user" && e.message.content === "selected"),
			).toBe(true);
			expect(result!.coldCompactionCount).toBe(0);
			expect(result!.coldUsageTotals.input).toBe(10);
			expect(loaded.some((e) => e.type === "label" && e.targetId === kept && e.label === "bookmark")).toBe(true);
			expect(buildSessionContext(loaded)).toEqual(expected);
		} finally {
			spy.mockRestore();
		}
	});

	it("preserves context-edit projection and raw history on the current path", () => {
		const { dir } = fixture();
		const manager = SessionManager.create(dir, dir);
		const target = manager.appendMessage({
			role: "user",
			content: `OMITTED-BODY-${"z".repeat(512 * 1024)}`,
			timestamp: Date.now(),
		} as never);
		manager.appendContextEdit(target, null);
		manager.appendMessage({ role: "user", content: "live", timestamp: Date.now() } as never);
		const expected = manager.buildSessionContext();
		const file = manager.getSessionFile()!;
		expect(buildOffsetIndex(file, [manager.getHeader()!, ...manager.getEntries()])).toBe(true);
		const loaded = loadIndexedActiveSession(file, readOffsetIndex(file)!);
		expect(loaded).not.toBeNull();
		const entries = loaded!.entries.slice(1) as Parameters<typeof buildSessionContext>[0];
		expect(buildSessionContext(entries)).toEqual(expected);
		expect(entries.find((entry) => entry.id === target && entry.type === "message")?.type).toBe("message");
		// Pi's TUI renders raw current-path entries even when a context_edit omits
		// their content from model input. The original is therefore still needed.
		expect(JSON.stringify(entries)).toContain("OMITTED-BODY-");
	});

	it("appends offset metadata without rewriting the snapshot and rejects a torn journal", () => {
		const { dir } = fixture();
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage({ role: "user", content: "first", timestamp: Date.now() } as never);
		const file = manager.getSessionFile()!;
		expect(buildOffsetIndex(file, [manager.getHeader()!, ...manager.getEntries()])).toBe(true);
		const snapshot = readFileSync(`${file}.idx`);
		const second = manager.appendMessage({ role: "user", content: "second", timestamp: Date.now() } as never);
		const third = manager.appendMessage({ role: "user", content: "third", timestamp: Date.now() } as never);
		expect(readFileSync(`${file}.idx`)).toEqual(snapshot);
		expect(statSync(`${file}.idx.delta`).mode & 0o077).toBe(0);
		const index = readOffsetIndex(file)!;
		expect(index.records.slice(-2).map((record) => record.id)).toEqual([second, third]);
		expect(loadIndexedActiveSession(file, index)?.entries.at(-1)?.type).toBe("message");
		chmodSync(`${file}.idx.delta`, 0o644);
		expect(readOffsetIndex(file)).toBeNull();
		chmodSync(`${file}.idx.delta`, 0o600);
		const moved = `${file}.idx.delta-copy`;
		renameSync(`${file}.idx.delta`, moved);
		symlinkSync(moved, `${file}.idx.delta`);
		expect(readOffsetIndex(file)).toBeNull();
		rmSync(`${file}.idx.delta`);
		renameSync(moved, `${file}.idx.delta`);
		expect(readOffsetIndex(file)).not.toBeNull();
		const source = readFileSync(file);
		writeFileSync(file, source.toString("utf8").replace('"third"', '"other"'));
		expect(readOffsetIndex(file)).toBeNull();
		writeFileSync(file, source);
		expect(readOffsetIndex(file)).not.toBeNull();
		writeFileSync(`${file}.idx.delta`, Buffer.concat([readFileSync(`${file}.idx.delta`), Buffer.from("{partial")]));
		expect(readOffsetIndex(file)).toBeNull();
		expect(readFileSync(file)).toEqual(source);
		const recovered = SessionManager.open(file);
		expect(recovered.getLeafId()).toBe(third);
		expect(readOffsetIndex(file)?.records.at(-1)?.id).toBe(third);
		expect(readFileSync(file)).toEqual(source);
	});

	it("rejects incomplete source lines and invalid indexes without editing the original", () => {
		const { file, entries } = fixture();
		const before = readFileSync(file);
		expect(buildOffsetIndex(file, entries)).toBe(true);
		const index = readOffsetIndex(file)!;
		writeFileSync(
			`${file}.idx`,
			JSON.stringify({
				...index,
				records: [{ ...index.records[0], end: index.records[0]!.end + 1 }, index.records[1]],
			}),
			{ mode: 0o600 },
		);
		expect(readOffsetIndex(file)).toBeNull();
		expect(readFileSync(file)).toEqual(before);
		writeFileSync(file, Buffer.concat([before, Buffer.from("partial")]));
		expect(readOffsetIndex(file)).toBeNull();
	});
});
