import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import type { FileEntry } from "../src/core/session-manager.js";
import {
	appendOffsetIndexWithCursor,
	buildOffsetIndex,
	createOffsetIndexAppendCursor,
	readOffsetIndex,
} from "../src/core/session-offset-index.js";

it("prints isolated metadata append timings (no production files)", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-index-append-bench-"));
	try {
		const file = join(dir, "synthetic.jsonl");
		const entries: FileEntry[] = [
			{ type: "session", version: 3, id: "synthetic", cwd: dir, timestamp: new Date().toISOString() } as FileEntry,
		];
		for (let i = 0; i < 5000; i++)
			entries.push({
				type: "session_info",
				id: `id-${i}`,
				parentId: i ? `id-${i - 1}` : null,
				timestamp: new Date().toISOString(),
				name: "title",
			} as FileEntry);
		writeFileSync(file, `${entries.map((x) => JSON.stringify(x)).join("\n")}\n`);
		if (!buildOffsetIndex(file, entries)) throw new Error("build failed");
		const cold = readOffsetIndex(file)!;
		if (!cold) throw new Error("no index");
		const cursor = createOffsetIndexAppendCursor(file, cold)!;
		if (!cursor) throw new Error("no cursor");
		const old: number[] = [];
		for (let i = 0; i < 5; i++) {
			const t = performance.now();
			if (!readOffsetIndex(file, true)) throw new Error("bad baseline");
			old.push(performance.now() - t);
		}
		const fast: number[] = [];
		for (let i = 0; i < 5; i++) {
			const entry = {
				type: "session_info",
				id: `new-${i}`,
				parentId: i ? `new-${i - 1}` : "id-4999",
				timestamp: new Date().toISOString(),
				name: "title",
			} as FileEntry;
			appendFileSync(file, `${JSON.stringify(entry)}\n`);
			const t = performance.now();
			if (!appendOffsetIndexWithCursor(file, entry as never, cursor)) throw new Error("fast append failed");
			fast.push(performance.now() - t);
		}
		console.log(
			JSON.stringify({
				syntheticRecords: entries.length - 1,
				fullIndexValidationMs: old.map((x) => +x.toFixed(2)),
				incrementalAppendMs: fast.map((x) => +x.toFixed(2)),
				meaning: "local index maintenance only, not model latency",
			}),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
