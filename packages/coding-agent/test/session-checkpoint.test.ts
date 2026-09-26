import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createCheckpointSession,
	createCheckpointSessionIfLarge,
	replaceStoppedSessionWithCheckpoint,
} from "../src/core/session-checkpoint.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup() {
	const dir = mkdtempSync(join(tmpdir(), "pi-checkpoint-"));
	dirs.push(dir);
	return { dir, manager: SessionManager.create(dir, dir) };
}
const user = (text: string) => ({ role: "user", content: text, timestamp: Date.now() }) as never;
const assistant = (text: string) =>
	({
		role: "assistant",
		content: [{ type: "text", text }],
		provider: "test",
		model: "model-a",
		stopReason: "stop",
		timestamp: Date.now(),
	}) as never;

describe("offline session checkpoint", () => {
	it("keeps the source unchanged while restoring exactly the current model messages", () => {
		const { dir, manager } = setup();
		manager.appendMessage({ role: "system", content: "system prompt", timestamp: Date.now() } as never);
		manager.appendMessage(user(`archived-${"x".repeat(300_000)}`));
		manager.appendMessage(assistant("old answer"));
		const retainedId = manager.appendMessage(user("kept prompt"));
		manager.appendMessage(assistant("kept answer"));
		manager.appendSessionInfo("test title");
		manager.appendCompaction("summary of old work", retainedId, 100_000);
		manager.appendMessage(user("new prompt"));
		const original = manager.getSessionFile()!;
		const before = readFileSync(original);
		const expected = manager.buildSessionContext();
		const result = createCheckpointSession(original, dir);
		expect(result.id).not.toBe(manager.getSessionId());
		expect(readFileSync(original)).toEqual(before);
		expect(statSync(result.path).size).toBeLessThan(before.length / 3);
		const restored = SessionManager.open(result.path);
		expect(restored.buildSessionContext()).toEqual(expected);
		expect(restored.getSessionName()).toBe("test title");
		expect(restored.getHeader().parentSession).toBe(original);
	});

	it("externalizes retained images and refuses incomplete source lines without modifying the archive", () => {
		const { dir, manager } = setup();
		manager.appendMessage({ role: "system", content: "system prompt", timestamp: Date.now() } as never);
		const data = Buffer.alloc(80_000, 42).toString("base64");
		const kept = manager.appendMessage({
			role: "user",
			content: [{ type: "image", data, mimeType: "image/png" }],
			timestamp: Date.now(),
		} as never);
		manager.appendMessage(assistant("observed"));
		manager.appendCompaction("image described", kept, 1500);
		const source = manager.getSessionFile()!;
		const before = readFileSync(source);
		const result = createCheckpointSession(source, dir);
		expect(readFileSync(source)).toEqual(before);
		expect(readFileSync(result.path, "utf8")).not.toContain(data);
		expect(readdirSync(`${result.path}.images`)).toHaveLength(1);
		expect(SessionManager.open(result.path).buildSessionContext()).toEqual(manager.buildSessionContext());
		appendFileSync(source, "incomplete");
		expect(() => createCheckpointSession(source, dir)).toThrow(/incomplete last line/);
		expect(readFileSync(source, "utf8")).toMatch(/incomplete$/);
	});

	it("keeps the same native id and path while archiving old bytes and image blobs", () => {
		const { dir, manager } = setup();
		manager.appendMessage({ role: "system", content: "system prompt", timestamp: Date.now() } as never);
		const oldImage = Buffer.alloc(200_000, 1).toString("base64");
		manager.appendMessage({
			role: "user",
			content: [{ type: "image", data: oldImage, mimeType: "image/png" }],
			timestamp: Date.now(),
		} as never);
		manager.appendMessage(assistant("old image seen"));
		const kept = manager.appendMessage(user(`kept-${"x".repeat(100_000)}`));
		manager.appendMessage(assistant("kept answer"));
		manager.appendCompaction("old picture summarized", kept, 9000);
		const freshImage = Buffer.alloc(150_000, 2).toString("base64");
		manager.appendMessage({
			role: "user",
			content: [{ type: "image", data: freshImage, mimeType: "image/png" }],
			timestamp: Date.now(),
		} as never);
		const source = manager.getSessionFile()!;
		const oldId = manager.getSessionId();
		const oldBytes = readFileSync(source);
		const context = manager.buildSessionContext();
		const result = replaceStoppedSessionWithCheckpoint(source);
		expect(result.path).toBe(source);
		// Botmux discovers UUID-suffixed .jsonl recursively: archives must not
		// also match that suffix, or the live transcript becomes ambiguous.
		expect(result.archivePath).not.toMatch(/\.jsonl$/);
		expect(SessionManager.findById(dir, oldId, dir)).toBe(source);
		expect(readFileSync(result.archivePath)).toEqual(oldBytes);
		expect(SessionManager.open(result.archivePath).getSessionId()).toBe(oldId);
		expect(SessionManager.open(source).getSessionId()).toBe(oldId);
		expect(SessionManager.open(source).buildSessionContext()).toEqual(context);
		expect(readdirSync(`${result.archivePath}.images`)).toHaveLength(2);
		expect(readdirSync(`${source}.images`)).toHaveLength(2);
	});

	it("leaves original bytes in place if the process fails before the atomic rename", () => {
		const { manager } = setup();
		manager.appendMessage({ role: "system", content: "system prompt", timestamp: Date.now() } as never);
		manager.appendMessage(user("old"));
		const keep = manager.appendMessage(assistant("keep"));
		manager.appendCompaction("summary", keep, 100);
		const source = manager.getSessionFile()!;
		const before = readFileSync(source);
		expect(() =>
			replaceStoppedSessionWithCheckpoint(source, {
				beforeReplace: () => {
					throw new Error("simulated process interruption");
				},
			}),
		).toThrow(/interruption/);
		expect(readFileSync(source)).toEqual(before);
		expect(readdirSync(join(manager.getSessionDir(), ".pi-archives"))).toHaveLength(0);
	});

	it("preserves a recoverable archive if failure follows the atomic rename", () => {
		const { manager } = setup();
		manager.appendMessage({ role: "system", content: "system prompt", timestamp: Date.now() } as never);
		manager.appendMessage(user(`old-${"x".repeat(50_000)}`));
		const keep = manager.appendMessage(assistant("keep"));
		manager.appendCompaction("summary", keep, 100);
		const source = manager.getSessionFile()!;
		const before = readFileSync(source);
		const expected = manager.buildSessionContext();
		expect(() =>
			replaceStoppedSessionWithCheckpoint(source, {
				afterReplace: () => {
					throw new Error("simulated post-rename interruption");
				},
			}),
		).toThrow(/post-rename/);
		const archiveRoot = join(manager.getSessionDir(), ".pi-archives");
		const archive = join(archiveRoot, readdirSync(archiveRoot)[0]!, `${basename(source)}.archive`);
		expect(readFileSync(archive)).toEqual(before);
		expect(SessionManager.open(source).buildSessionContext()).toEqual(expected);
	});

	it("never replaces an uncheckpointable source", () => {
		const { manager } = setup();
		manager.appendMessage(user("hello"));
		manager.appendMessage(assistant("world"));
		const source = manager.getSessionFile()!;
		const before = readFileSync(source);
		expect(() => replaceStoppedSessionWithCheckpoint(source)).toThrow(/compaction/);
		expect(readFileSync(source)).toEqual(before);
	});

	it("retains model and thinking settings across a retain-none compaction", () => {
		const { dir, manager } = setup();
		manager.appendMessage({ role: "system", content: "system prompt", timestamp: Date.now() } as never);
		manager.appendMessage(assistant("persist the old session"));
		manager.appendModelChange("test-provider", "test-model");
		manager.appendThinkingLevelChange("high");
		manager.appendMessage(user("old"));
		manager.appendCompaction("only summary", null, 1800);
		manager.appendMessage(user("new"));
		const sourceContext = manager.buildSessionContext();
		const fresh = SessionManager.open(createCheckpointSession(manager.getSessionFile()!, dir).path);
		expect(fresh.buildSessionContext()).toEqual(sourceContext);
		expect(fresh.buildSessionContext().thinkingLevel).toBe("high");
		expect(fresh.buildSessionContext().model).toEqual({ provider: "test-provider", modelId: "test-model" });
	});

	it("only offers a checkpoint after the independent raw-byte ceiling", () => {
		const { dir, manager } = setup();
		manager.appendMessage({ role: "system", content: "system prompt", timestamp: Date.now() } as never);
		const kept = manager.appendMessage(user("active"));
		manager.appendMessage(assistant("answer"));
		manager.appendCompaction("summary", kept, 1000);
		const source = manager.getSessionFile()!;
		const size = statSync(source).size;
		expect(createCheckpointSessionIfLarge(source, dir, size)).toBeNull();
		expect(createCheckpointSessionIfLarge(source, dir, size - 1)?.path).toMatch(/\.jsonl$/);
		expect(() => createCheckpointSessionIfLarge(source, dir, 0)).toThrow(/threshold/);
	});

	it("refuses to summarize a session that has no system checkpoint", () => {
		const { dir, manager } = setup();
		manager.appendMessage(user("hello"));
		manager.appendMessage(assistant("world"));
		expect(() => createCheckpointSession(manager.getSessionFile()!, dir)).toThrow(/compaction/);
	});

	it("allows continued append on a resumed checkpoint without altering its archive", () => {
		const { dir, manager } = setup();
		manager.appendMessage({ role: "system", content: "system prompt", timestamp: Date.now() } as never);
		const retainedId = manager.appendMessage(user("hello"));
		manager.appendMessage(assistant("world"));
		manager.appendCompaction("summary", retainedId, 1000);
		const oldFile = manager.getSessionFile()!;
		const result = createCheckpointSession(oldFile, dir);
		const oldBytes = statSync(oldFile).size;
		const restored = SessionManager.open(result.path);
		restored.appendMessage(user("next"));
		expect(restored.buildSessionContext().messages.at(-1)).toMatchObject({ role: "user", content: "next" });
		expect(statSync(oldFile).size).toBe(oldBytes);
	});
});
