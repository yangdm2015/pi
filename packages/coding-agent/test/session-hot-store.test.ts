import { createHash } from "crypto";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";

const dirs: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function source() {
	const dir = mkdtempSync(join(tmpdir(), "pi-hot-session-"));
	dirs.push(dir);
	const manager = SessionManager.create(dir, dir);
	const now = Date.now();
	manager.appendMessage({ role: "system", content: "system prompt", timestamp: now } as never);
	manager.appendModelChange("test-provider", "test-model");
	manager.appendThinkingLevelChange("high");
	manager.appendMessage({
		role: "user",
		content: `archived-MARKER-${"x".repeat(11 * 1024 * 1024)}`,
		timestamp: now,
	} as never);
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "old" }],
		provider: "test",
		model: "test",
		stopReason: "stop",
		usage: {
			input: 10,
			output: 2,
			cacheRead: 3,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
		},
		timestamp: now,
	} as never);
	const keep = manager.appendMessage({ role: "user", content: "retained", timestamp: now } as never);
	manager.appendCompaction("old messages summarized", keep, 99999);
	return manager;
}

describe("same logical Pi session with bounded hot storage", () => {
	it("retains original JSONL and ID while cold loading the checkpoint without parsing old bodies", () => {
		const manager = source();
		const file = manager.getSessionFile()!;
		const id = manager.getSessionId();
		const bytes = readFileSync(file);
		const context = manager.buildSessionContext();
		const usage = manager.getUsageSnapshot().totals;
		const compactions = manager.getCompactionCount();
		expect(statSync(`${file}.hot`).size).toBeLessThan(100_000);
		const parse = JSON.parse;
		vi.spyOn(JSON, "parse").mockImplementation((text: string, ...args: unknown[]) => {
			if (typeof text === "string" && text.includes("archived-MARKER-")) throw new Error("parsed cold body");
			return parse(text, ...(args as [any]));
		});
		const restored = SessionManager.open(file);
		expect(restored.getSessionId()).toBe(id);
		expect(restored.getSessionFile()).toBe(file);
		expect(restored.buildSessionContext()).toEqual(context);
		expect(restored.getUsageSnapshot().totals).toEqual(usage);
		expect(restored.getCompactionCount()).toBe(compactions);
		expect(createHash("sha256").update(readFileSync(file)).digest("hex")).toBe(
			createHash("sha256").update(bytes).digest("hex"),
		);
	});

	it("leaves active images as refs until explicitly viewed or sent to the model", () => {
		const manager = source();
		const data = Buffer.from("small image test bytes").toString("base64");
		manager.appendMessage({
			role: "user",
			content: [{ type: "image", data, mimeType: "image/png" }],
			timestamp: Date.now(),
		} as never);
		const file = manager.getSessionFile()!;
		const opened = SessionManager.open(file);
		const entry = opened.getActiveEntries().at(-1);
		expect(entry?.type).toBe("message");
		if (entry?.type !== "message" || !Array.isArray(entry.message.content)) throw new Error("Missing image");
		expect(entry.message.content[0]).toMatchObject({ data: expect.stringMatching(/^pi-blob:\/\/sha256\//) });
		expect(opened.buildSessionContext().messages.at(-1)).toMatchObject({
			content: [{ type: "image", data, mimeType: "image/png" }],
		});
		const blob = readdirSync(`${file}.images`)[0]!;
		writeFileSync(`${file}.images/${blob}`, "corrupt");
		// Cold open has no reason to read the blob; requested model data must fail closed.
		const lazy = SessionManager.open(file);
		expect(() => lazy.buildSessionContext()).toThrow(/Corrupt/);
	});

	it("keeps model state, cumulative totals and both compactions across repeated cold resumes", () => {
		const manager = source();
		const file = manager.getSessionFile()!;
		const resumed = SessionManager.open(file);
		const kept = resumed.appendMessage({ role: "user", content: "second retained", timestamp: Date.now() } as never);
		resumed.appendCompaction("second summary", kept, 100);
		const expected = resumed.buildSessionContext();
		const totals = resumed.getUsageSnapshot().totals;
		const twice = SessionManager.open(file);
		expect(twice.getCompactionCount()).toBe(2);
		expect(twice.getUsageSnapshot().totals).toEqual(totals);
		expect(twice.buildSessionContext()).toEqual(expected);
		expect(twice.getActiveDiskBytes()).toBeLessThan(100_000);
	});

	it("reads the appended active tail and refuses a stale or corrupt sidecar", () => {
		const manager = source();
		const file = manager.getSessionFile()!;
		const now = Date.now();
		const entry = {
			type: "message",
			id: "future234",
			parentId: manager.getLeafId(),
			timestamp: new Date().toISOString(),
			message: { role: "user", content: "new appended turn", timestamp: now },
		};
		appendFileSync(file, `${JSON.stringify(entry)}\n`);
		const resumed = SessionManager.open(file);
		expect(resumed.buildSessionContext().messages.at(-1)).toMatchObject({
			role: "user",
			content: "new appended turn",
		});
		expect(resumed.buildSessionContext().messages.some((m) => m.role === "user" && m.content === "retained")).toBe(
			true,
		);
		expect(resumed.buildSessionContext().messages.slice(0, -1)).toEqual(manager.buildSessionContext().messages);
		expect(resumed.buildSessionContext().model).toEqual(manager.buildSessionContext().model);
		expect(resumed.buildSessionContext().thinkingLevel).toBe(manager.buildSessionContext().thinkingLevel);
		// A bounded page parses only requested lines, without materializing old history.
		let cursor: number | null = 0;
		const pages: number[] = [];
		while (cursor !== null) {
			const page = resumed.getArchivedEntriesPage(cursor, 2);
			pages.push(page.entries.length);
			cursor = page.nextCursor;
		}
		expect(pages).toEqual([2, 2, 2, 2]);
		// Explicit full-history inspection still materializes old entries when asked.
		expect(
			resumed
				.getEntries()
				.some(
					(e) =>
						e.type === "message" &&
						e.message.role === "user" &&
						typeof e.message.content === "string" &&
						e.message.content.startsWith("archived-MARKER-"),
				),
		).toBe(true);
		writeFileSync(`${file}.hot`, "{corrupt\n");
		const fallback = SessionManager.open(file);
		expect(fallback.buildSessionContext().messages.at(-1)).toMatchObject({
			role: "user",
			content: "new appended turn",
		});
	});
});
