import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { hydrateImageRefs, serializeWithImageRefs } from "../src/core/session-image-store.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const newDir = () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-images-"));
	dirs.push(dir);
	return dir;
};
const image = Buffer.alloc(1024, 123).toString("base64");

function entry() {
	return {
		type: "message",
		message: {
			role: "user",
			content: [
				{ type: "text", text: "see" },
				{ type: "image", data: image, mimeType: "image/png" },
			],
		},
	};
}

describe("session image store", () => {
	it("stores a content hash reference while keeping the in-memory message unchanged", () => {
		const file = join(newDir(), "session.jsonl");
		const source = entry();
		const json = serializeWithImageRefs(source, file);
		expect(json).not.toContain(image);
		expect(source.message.content[1]).toEqual({ type: "image", data: image, mimeType: "image/png" });
		const blobs = readdirSync(`${file}.images`);
		expect(blobs).toHaveLength(1);
		expect(statSync(join(`${file}.images`, blobs[0]!)).mode & 0o777).toBe(0o600);
		expect(hydrateImageRefs(JSON.parse(json), file)).toEqual(source);
	});

	it("integrates with JSONL persistence and resume", () => {
		const dir = newDir();
		const manager = SessionManager.create(dir, dir);
		const file = manager.getSessionFile()!;
		manager.appendMessage({ role: "user", content: entry().message.content, timestamp: Date.now() } as never);
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			timestamp: Date.now(),
			provider: "test",
			model: "test",
			stopReason: "stop",
		} as never);
		expect(readFileSync(file, "utf8")).not.toContain(image);
		const reopened = SessionManager.open(file);
		const user = reopened.getEntries().find((e) => e.type === "message" && e.message.role === "user");
		expect(user && user.type === "message" && user.message.content).toEqual(entry().message.content);
	});

	it("fails closed on a missing or symlinked image instead of silently losing context", () => {
		const file = join(newDir(), "session.jsonl");
		const json = serializeWithImageRefs(entry(), file);
		const blob = join(`${file}.images`, readdirSync(`${file}.images`)[0]!);
		unlinkSync(blob);
		expect(() => hydrateImageRefs(JSON.parse(json), file)).toThrow();
		symlinkSync("/etc/hosts", blob);
		expect(() => hydrateImageRefs(JSON.parse(json), file)).toThrow(/Unsafe/);
	});
});
