import { createHash, randomUUID } from "crypto";
import {
	closeSync,
	lstatSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "fs";
import { StringDecoder } from "string_decoder";
import { serializeWithImageRefs } from "./session-image-store.ts";
import type { FileEntry, SessionHeader } from "./session-manager.ts";
import type { UsageTotals } from "./usage-totals.ts";

const ANCHOR_BYTES = 8192;
const MAX_HOT_FILE_BYTES = 32 * 1024 * 1024;
interface HotSnapshot {
	version: 1;
	id: string;
	dev: number;
	ino: number;
	offset: number;
	anchor: string;
	coldCompactionCount: number;
	coldUsageTotals: UsageTotals;
	entries: FileEntry[];
}

function anchor(file: string, offset: number): string {
	const size = Math.min(ANCHOR_BYTES, offset);
	const bytes = Buffer.alloc(size);
	const fd = openSync(file, "r");
	try {
		if (readSync(fd, bytes, 0, size, offset - size) !== size) throw new Error("Checkpoint anchor truncated");
	} finally {
		closeSync(fd);
	}
	if (bytes.at(-1) !== 10) throw new Error("Checkpoint boundary must end with a newline");
	return createHash("sha256").update(bytes).digest("hex");
}

function parseTail(file: string, offset: number): FileEntry[] | null {
	const result: FileEntry[] = [];
	const fd = openSync(file, "r");
	let pending = "";
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(64 * 1024);
		let cursor = offset;
		while (true) {
			const count = readSync(fd, buffer, 0, buffer.length, cursor);
			if (count === 0) break;
			cursor += count;
			pending += decoder.write(buffer.subarray(0, count));
			let i = pending.indexOf("\n");
			while (i !== -1) {
				const line = pending.slice(0, i);
				pending = pending.slice(i + 1);
				if (line.trim()) {
					try {
						result.push(JSON.parse(line) as FileEntry);
					} catch (error) {
						if (error instanceof SyntaxError) return null;
						throw error;
					}
				}
				i = pending.indexOf("\n");
			}
		}
		pending += decoder.end();
		return pending.length === 0 ? result : null;
	} finally {
		closeSync(fd);
	}
}

/** Best-effort acceleration only. An invalid/stale sidecar falls back to the
 * authoritative append-only JSONL. Image blobs are read only at a context/view boundary. */
export function loadHotSession(file: string): {
	entries: FileEntry[];
	offset: number;
	coldCompactionCount: number;
	coldUsageTotals: UsageTotals;
} | null {
	const hot = `${file}.hot`;
	let saved: HotSnapshot;
	try {
		const stat = lstatSync(hot);
		if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > MAX_HOT_FILE_BYTES)
			return null;
		saved = JSON.parse(readFileSync(hot, "utf8")) as HotSnapshot;
		const source = statSync(file);
		if (
			saved.version !== 1 ||
			!Number.isSafeInteger(saved.offset) ||
			saved.offset < 1 ||
			source.dev !== saved.dev ||
			source.ino !== saved.ino ||
			source.size < saved.offset ||
			!Array.isArray(saved.entries) ||
			saved.entries[0]?.type !== "session" ||
			!Number.isSafeInteger(saved.coldCompactionCount) ||
			saved.coldCompactionCount < 0 ||
			!saved.coldUsageTotals ||
			!Number.isFinite(saved.coldUsageTotals.cost) ||
			(saved.entries[0] as SessionHeader).id !== saved.id ||
			anchor(file, saved.offset) !== saved.anchor
		)
			return null;
		// The header is near the start; inspect it without parsing old bodies.
		const fd = openSync(file, "r");
		try {
			const head = Buffer.alloc(64 * 1024);
			const count = readSync(fd, head, 0, head.length, 0);
			const newline = head.subarray(0, count).indexOf(10);
			if (newline < 0 || (JSON.parse(head.subarray(0, newline).toString("utf8")) as SessionHeader).id !== saved.id)
				return null;
		} finally {
			closeSync(fd);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
		throw error;
	}
	const tail = parseTail(file, saved.offset);
	if (!tail || tail.some((e) => e.type === "session")) return null;
	return {
		entries: [...saved.entries, ...tail],
		offset: saved.offset,
		coldCompactionCount: saved.coldCompactionCount,
		coldUsageTotals: saved.coldUsageTotals,
	};
}

/** Writes only an auxiliary snapshot; never truncates or replaces the source. */
export function saveHotSession(
	file: string,
	entries: FileEntry[],
	coldCompactionCount: number,
	coldUsageTotals: UsageTotals,
): boolean {
	if (!entries.length || entries[0]?.type !== "session") return false;
	const before = statSync(file);
	const saved: HotSnapshot = {
		version: 1,
		id: (entries[0] as SessionHeader).id,
		dev: before.dev,
		ino: before.ino,
		offset: before.size,
		anchor: anchor(file, before.size),
		coldCompactionCount,
		coldUsageTotals,
		entries: entries.map((entry) => JSON.parse(serializeWithImageRefs(entry, file)) as FileEntry),
	};
	const hot = `${file}.hot`;
	const serialized = JSON.stringify(saved);
	if (Buffer.byteLength(serialized) > MAX_HOT_FILE_BYTES) return false;
	const temp = `${hot}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temp, serialized, { mode: 0o600, flag: "wx" });
		const now = statSync(file);
		if (
			now.ino !== before.ino ||
			now.dev !== before.dev ||
			now.size !== before.size ||
			now.mtimeMs !== before.mtimeMs
		)
			return false;
		renameSync(temp, hot);
		return true;
	} finally {
		try {
			unlinkSync(temp);
		} catch {
			/* already published or absent */
		}
	}
}
