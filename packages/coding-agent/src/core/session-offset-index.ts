import { createHash, randomUUID } from "node:crypto";
import type { Usage } from "@earendil-works/pi-ai";
import { closeSync, lstatSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { FileEntry, SessionEntry, SessionHeader } from "./session-manager.ts";
import { addUsageToTotals, createUsageTotals, type UsageTotals } from "./usage-totals.ts";

const CHUNK_BYTES = 64 * 1024;
const ANCHOR_BYTES = 8192;

export interface OffsetRecord {
	id: string;
	parentId: string | null;
	type: string;
	start: number;
	end: number;
	usage?: Usage;
	role?: string;
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
	checksum?: string;
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
			if (entry.type === "message") {
				record.role = entry.message.role;
				if (entry.message.role === "assistant" || entry.message.role === "toolResult") record.usage = entry.message.usage;
				if (entry.message.role === "assistant") record.model = { provider: entry.message.provider, modelId: entry.message.model };
			}
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
			index.checksum = createHash("sha256").update(JSON.stringify(index)).digest("hex");
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
export function readOffsetIndex(file: string, allowAppendedSource = false): OffsetIndex | null {
	try {
		const source = lstatSync(file);
		const side = lstatSync(`${file}.idx`);
		if (!source.isFile() || source.isSymbolicLink() || !side.isFile() || side.isSymbolicLink() || (side.mode & 0o077) !== 0)
			return null;
		const index = JSON.parse(readFileSync(`${file}.idx`, "utf8")) as OffsetIndex;
		const { checksum, ...payload } = index;
		if (typeof checksum !== "string" || createHash("sha256").update(JSON.stringify(payload)).digest("hex") !== checksum) return null;
		if (index.version !== 1 || typeof index.id !== "string" || !index.id || index.dev !== source.dev || index.ino !== source.ino ||
			(allowAppendedSource ? index.offset > source.size : index.offset !== source.size) || !Array.isArray(index.records) ||
			!Number.isSafeInteger(index.offset) || index.offset < 1 || index.records.length > index.offset) return null;
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

/** Keep the authoritative append first; publish the metadata update atomically.
 * Rewriting metadata does not read or deserialize earlier JSONL bodies. */
export function appendOffsetIndex(file: string, entry: SessionEntry): boolean {
	const index = readOffsetIndex(file, true);
	if (!index) return false;
	const path = `${file}.idx`;
	const temp = `${path}.${randomUUID()}.tmp`;
	try {
		const before = statSync(file);
		const length = before.size - index.offset;
		if (length < 2) return false;
		const tail = readAt(file, index.offset, length);
		if (tail.at(-1) !== 10 || tail.indexOf(10) !== length - 1 || index.records.some(record => record.id === entry.id)) return false;
		const record: OffsetRecord = { id: entry.id, parentId: entry.parentId, type: entry.type, start: index.offset, end: before.size };
		if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") record.usage = entry.usage;
		if (entry.type === "message") {
			record.role = entry.message.role;
			if (entry.message.role === "assistant" || entry.message.role === "toolResult") record.usage = entry.message.usage;
			if (entry.message.role === "assistant") record.model = { provider: entry.message.provider, modelId: entry.message.model };
		}
		if (entry.type === "model_change") record.model = { provider: entry.provider, modelId: entry.modelId };
		if (entry.type === "thinking_level_change") record.thinkingLevel = entry.thinkingLevel;
		if (entry.type === "compaction") record.firstKeptEntryId = entry.firstKeptEntryId;
		if (entry.type === "label") record.label = { targetId: entry.targetId, value: entry.label, timestamp: entry.timestamp };
		if (entry.type === "session_info") record.name = entry.name;
		if (entry.type === "context_edit") record.targetId = entry.targetId;
		index.records.push(record);
		index.offset = before.size;
		index.anchor = sourceAnchor(file, before.size);
		delete index.checksum;
		index.checksum = createHash("sha256").update(JSON.stringify(index)).digest("hex");
		writeFileSync(temp, JSON.stringify(index), { flag: "wx", mode: 0o600 });
		const after = statSync(file);
		if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) return false;
		renameSync(temp, path);
		return true;
	} catch {
		return false;
	} finally {
		try { unlinkSync(temp); } catch { /* published or already removed */ }
	}
}

/** Use the index for topology; JSON-parse original bodies only after selecting
 * the active path and the entries retained by its newest compaction. */
export function loadIndexedActiveSession(file: string, index: OffsetIndex): {
	entries: FileEntry[];
	coldUsageTotals: UsageTotals;
	coldCompactionCount: number;
	activeBytes: number;
} | null {
	try {
		const source = statSync(file);
		if (source.dev !== index.dev || source.ino !== index.ino || source.size !== index.offset) return null;
		const byId = new Map(index.records.map(record => [record.id, record]));
		const reversePath: OffsetRecord[] = [];
		const visited = new Set<string>();
		let current = index.records.at(-1);
		while (current) {
			if (visited.has(current.id)) return null;
			visited.add(current.id);
			reversePath.push(current);
			if (current.parentId && !byId.has(current.parentId)) return null;
			current = current.parentId ? byId.get(current.parentId) : undefined;
		}
		const path = reversePath.reverse();
		const compactIndex = path.findLastIndex(record => record.type === "compaction");
		let selected: OffsetRecord[];
		if (compactIndex < 0) {
			selected = path;
		} else {
			const compact = path[compactIndex]!;
			const first = compact.firstKeptEntryId === compact.id
				? compactIndex
				: path.findIndex(record => record.id === compact.firstKeptEntryId);
			if (first < 0 || first > compactIndex) return null;
			selected = [
				...path.slice(first, compactIndex).filter(record => !(record.type === "message" && record.role === "system")),
				...path.slice(compactIndex),
			];
		}
		const headerEnd = index.records[0]?.start ?? index.offset;
		if (headerEnd < 2 || headerEnd > CHUNK_BYTES) return null;
		const header = JSON.parse(readAt(file, 0, headerEnd - 1).toString("utf8")) as SessionHeader;
		if (header.type !== "session" || header.id !== index.id) return null;
		const prefix: SessionEntry[] = [];
		let syntheticTitle: SessionEntry | undefined;
		if (compactIndex >= 0) {
			let model: OffsetRecord["model"];
			let thinkingLevel: string | undefined;
			for (const record of path.slice(0, compactIndex)) {
				if (record.model) model = record.model;
				if (record.thinkingLevel) thinkingLevel = record.thinkingLevel;
			}
			const timestamp = new Date().toISOString();
			if (model) prefix.push({ type: "model_change", id: randomUUID(), parentId: null, timestamp, ...model });
			if (thinkingLevel && thinkingLevel !== "off")
				prefix.push({ type: "thinking_level_change", id: randomUUID(), parentId: null, timestamp, thinkingLevel });
			const title = index.records.findLast(record => record.type === "session_info" && record.name !== undefined);
			if (title) syntheticTitle = { type: "session_info", id: randomUUID(), parentId: null, timestamp, name: title.name };
		}
		const bodies = selected.map(record => {
			const bytes = readAt(file, record.start, record.end - record.start);
			if (bytes.at(-1) !== 10) throw new Error("Incomplete indexed entry");
			const entry = JSON.parse(bytes.subarray(0, -1).toString("utf8")) as SessionEntry;
			if (entry.id !== record.id || entry.parentId !== record.parentId || entry.type !== record.type)
				throw new Error("Indexed entry mismatch");
			return entry;
		});
		const activeIds = new Set(bodies.map(entry => entry.id));
		const labels = new Map<string, OffsetRecord>();
		for (const record of index.records) {
			if (record.type === "label" && record.label && activeIds.has(record.label.targetId))
				labels.set(record.label.targetId, record);
		}
		const syntheticLabels: SessionEntry[] = [];
		for (const record of labels.values()) {
			if (activeIds.has(record.id) || !record.label) continue;
			syntheticLabels.push({ type: "label", id: randomUUID(), parentId: null,
				timestamp: record.label.timestamp, targetId: record.label.targetId, label: record.label.value });
		}
		// Preserve the real last entry as the leaf; synthetic latest label state
		// goes after earlier selected labels, before that leaf.
		const active = bodies.length
			? [...prefix, ...bodies.slice(0, -1), ...(syntheticTitle ? [syntheticTitle] : []), ...syntheticLabels, bodies.at(-1)!]
			: [...prefix, ...(syntheticTitle ? [syntheticTitle] : []), ...syntheticLabels];
		const coldUsageTotals = createUsageTotals();
		let coldCompactionCount = 0;
		for (const record of index.records) {
			if (activeIds.has(record.id)) continue;
			if (record.type === "compaction") coldCompactionCount++;
			if (record.usage) addUsageToTotals(coldUsageTotals, record.usage);
		}
		// Like the legacy hot snapshot, the selected branch is a compact in-memory
		// projection; the authoritative file and indexed parent pointers stay intact.
		const compacted = structuredClone(active);
		for (let i = 0; i < compacted.length; i++) compacted[i]!.parentId = i ? compacted[i - 1]!.id : null;
		const after = statSync(file);
		if (after.dev !== source.dev || after.ino !== source.ino || after.size !== source.size || sourceAnchor(file, index.offset) !== index.anchor)
			return null;
		return { entries: [header, ...compacted], coldUsageTotals, coldCompactionCount,
			activeBytes: selected.reduce((sum, record) => sum + record.end - record.start, 0) };
	} catch {
		return null;
	}
}
