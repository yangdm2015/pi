import { createHash, randomUUID } from "node:crypto";
import type { Usage } from "@earendil-works/pi-ai";
import { closeSync, lstatSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { FileEntry, SessionEntry } from "./session-manager.ts";

const CHUNK_BYTES = 64 * 1024;
const ANCHOR_BYTES = 8192;

export interface OffsetRecord {
	id: string;
	parentId: string | null;
	type: string;
	start: number;
	end: number;
	usage?: Usage;
	model?: { provider: string; modelId: string };
	thinkingLevel?: string;
	firstKeptEntryId?: string;
	label?: { targetId: string; value: string | undefined; timestamp: string };
	name?: string;
	targetId?: string;
}

export interface OffsetIndex {
	version: 1;
	id: string;
	dev: number;
	ino: number;
	offset: number;
	anchor: string;
	records: OffsetRecord[];
}

function readAt(file: string, offset: number, length: number): Buffer {
	const fd = openSync(file, "r");
	try {
		const result = Buffer.alloc(length);
		if (readSync(fd, result, 0, length, offset) !== length) throw new Error("Incomplete session source");
		return result;
	} finally {
		closeSync(fd);
	}
}

function sourceAnchor(file: string, offset: number): string {
	const last = readAt(file, offset - Math.min(ANCHOR_BYTES, offset), Math.min(ANCHOR_BYTES, offset));
	if (last.at(-1) !== 10) throw new Error("Incomplete session line");
	return createHash("sha256").update(last).digest("hex");
}

/** Byte-only line scan: rebuilding already has validated entries and must not
 * deserialize their bodies again merely to discover the physical offsets. */
function lineEnds(file: string, length: number): number[] {
	const fd = openSync(file, "r");
	const result: number[] = [];
	const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
	try {
		let offset = 0;
		while (offset < length) {
			const count = readSync(fd, buffer, 0, Math.min(buffer.length, length - offset), offset);
			if (!count) throw new Error("Incomplete source read");
			for (let i = 0; i < count; i++) if (buffer[i] === 10) result.push(offset + i + 1);
			offset += count;
		}
		if (result.at(-1) !== length) throw new Error("Incomplete last line");
		return result;
	} finally {
		closeSync(fd);
	}
}

/** Full-load recovery only. The original JSONL is never rewritten here. */
export function buildOffsetIndex(file: string, validatedEntries: FileEntry[]): boolean {
	if (validatedEntries[0]?.type !== "session") return false;
	const header = validatedEntries[0];
	try {
		const before = statSync(file);
		if (!before.isFile() || before.size < 1) return false;
		const ends = lineEnds(file, before.size);
		if (ends.length !== validatedEntries.length || ends[0]! > CHUNK_BYTES) return false;
		const physicalHeader = JSON.parse(readAt(file, 0, ends[0]! - 1).toString("utf8")) as { type?: string; id?: string };
		if (physicalHeader.type !== "session" || physicalHeader.id !== header.id) return false;
		const records = validatedEntries.slice(1).map((value, i): OffsetRecord => {
			const entry = value as SessionEntry;
			const record: OffsetRecord = { id: entry.id, parentId: entry.parentId, type: entry.type, start: ends[i]!, end: ends[i + 1]! };
			if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") record.usage = entry.usage;
			if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")) record.usage = entry.message.usage;
			if (entry.type === "model_change") record.model = { provider: entry.provider, modelId: entry.modelId };
			if (entry.type === "thinking_level_change") record.thinkingLevel = entry.thinkingLevel;
			if (entry.type === "compaction") record.firstKeptEntryId = entry.firstKeptEntryId;
			if (entry.type === "label") record.label = { targetId: entry.targetId, value: entry.label, timestamp: entry.timestamp };
			if (entry.type === "session_info") record.name = entry.name;
			if (entry.type === "context_edit") record.targetId = entry.targetId;
			return record;
		});
		const index: OffsetIndex = {
			version: 1, id: header.id, dev: before.dev, ino: before.ino,
			offset: before.size, anchor: sourceAnchor(file, before.size), records,
		};
		const path = `${file}.idx`;
		const temp = `${path}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temp, JSON.stringify(index), { flag: "wx", mode: 0o600 });
			const after = statSync(file);
			if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) return false;
			renameSync(temp, path);
			return true;
		} finally {
			try { unlinkSync(temp); } catch { /* published or already removed */ }
		}
	} catch {
		return false;
	}
}

/** An untrusted or lagging index is not authority: the caller may full-load. */
export function readOffsetIndex(file: string): OffsetIndex | null {
	try {
		const source = lstatSync(file);
		const side = lstatSync(`${file}.idx`);
		if (!source.isFile() || source.isSymbolicLink() || !side.isFile() || side.isSymbolicLink() || (side.mode & 0o077) !== 0)
			return null;
		const index = JSON.parse(readFileSync(`${file}.idx`, "utf8")) as OffsetIndex;
		if (index.version !== 1 || typeof index.id !== "string" || !index.id || index.dev !== source.dev || index.ino !== source.ino ||
			index.offset !== source.size || !Array.isArray(index.records) || !Number.isSafeInteger(index.offset) || index.offset < 1 ||
			index.records.length > index.offset) return null;
		const first = readAt(file, 0, Math.min(source.size, CHUNK_BYTES));
		const headerEnd = first.indexOf(10);
		const header = headerEnd < 0 ? null : JSON.parse(first.subarray(0, headerEnd).toString("utf8")) as { id?: string; type?: string };
		if (header?.type !== "session" || header.id !== index.id)
			return null;
		let end = headerEnd + 1;
		const ids = new Set<string>();
		for (const record of index.records) {
			if (typeof record.id !== "string" || !record.id || ids.has(record.id) || typeof record.type !== "string" || !record.type ||
				(record.parentId !== null && typeof record.parentId !== "string") || !Number.isSafeInteger(record.start) ||
				!Number.isSafeInteger(record.end) || record.start !== end || record.end <= record.start || record.end > index.offset)
				return null;
			ids.add(record.id);
			end = record.end;
		}
		if (end !== index.offset || sourceAnchor(file, index.offset) !== index.anchor) return null;
		return index;
	} catch {
		return null;
	}
}
