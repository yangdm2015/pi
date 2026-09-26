import { randomUUID } from "crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readSync, rmSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { serializeWithImageRefs } from "./session-image-store.ts";
import {
	buildContextEntries,
	buildSessionContext,
	type CompactionEntry,
	CURRENT_SESSION_VERSION,
	type FileEntry,
	loadEntriesFromFile,
	type SessionEntry,
	type SessionHeader,
} from "./session-manager.ts";

export interface CheckpointSessionResult {
	path: string;
	id: string;
	entries: number;
}

/** Compaction bounds model tokens; this independent byte ceiling bounds the
 * raw file's size. Invoke only after the producer is idle. */
export function createCheckpointSessionIfLarge(
	sourcePath: string,
	outputDir: string,
	maxHotBytes = 10 * 1024 * 1024,
): CheckpointSessionResult | null {
	if (!Number.isSafeInteger(maxHotBytes) || maxHotBytes < 1) throw new Error("Invalid checkpoint byte threshold");
	const stats = lstatSync(sourcePath);
	if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Checkpoint source must be a regular file");
	return stats.size > maxHotBytes ? createCheckpointSession(sourcePath, outputDir) : null;
}

/**
 * Explicit, offline checkpoint: keep the old JSONL unchanged and create a NEW
 * session with only the current compaction summary and its active suffix.
 * Callers must retire the old session and independently bind the new session;
 * this function never switches a running CLI or a botmux transcript watcher.
 */
export function createCheckpointSession(sourcePath: string, outputDir: string): CheckpointSessionResult {
	const source = resolve(sourcePath);
	const before = lstatSync(source);
	if (!before.isFile() || before.isSymbolicLink()) throw new Error("Checkpoint source must be a regular file");
	if (before.size === 0) throw new Error("Cannot checkpoint an empty session");
	const sourceFd = openSync(source, "r");
	try {
		const lastByte = Buffer.alloc(1);
		if (readSync(sourceFd, lastByte, 0, 1, before.size - 1) !== 1 || lastByte[0] !== 0x0a)
			throw new Error("Source session has an incomplete last line; retry after it is idle");
	} finally {
		closeSync(sourceFd);
	}
	const raw = loadEntriesFromFile(source);
	const header = raw[0];
	if (!header || header.type !== "session") throw new Error("Missing session header");
	const entries = raw.slice(1) as SessionEntry[];
	const leaf = entries.at(-1)?.id;
	const selected = buildContextEntries(entries, leaf);
	const compaction = selected[0] as CompactionEntry | undefined;
	if (compaction?.type !== "compaction" || !compaction.systemMessage) {
		throw new Error("Cannot checkpoint without a complete compaction/system prompt checkpoint");
	}
	// Other branches and extension state may still refer to old entries. Keep
	// their authoritative bytes in the old file rather than inventing a replay.
	const id = randomUUID();
	const timestamp = new Date().toISOString();
	const newHeader: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id,
		timestamp,
		cwd: (header as SessionHeader).cwd,
		parentSession: source,
	};
	const current = buildSessionContext(entries, leaf);
	const state: SessionEntry[] = [];
	if (current.model)
		state.push({ type: "model_change", id: randomUUID(), parentId: null, timestamp, ...current.model });
	if (current.thinkingLevel !== "off")
		state.push({
			type: "thinking_level_change",
			id: randomUUID(),
			parentId: null,
			timestamp,
			thinkingLevel: current.thinkingLevel,
		});
	// Preserve the session title even if it predates compaction. All older labels,
	// metrics, branches and extension entries remain available in the parent file.
	const title = entries
		.slice()
		.reverse()
		.find((e) => e.type === "session_info") as Extract<SessionEntry, { type: "session_info" }> | undefined;
	if (title) state.push({ ...title, id: randomUUID(), parentId: null, timestamp });
	const compacted = structuredClone([compaction, ...state, ...selected.slice(1)]) as SessionEntry[];
	for (let i = 0; i < compacted.length; i++) compacted[i]!.parentId = i ? compacted[i - 1]!.id : null;
	// The source may be actively appended. Never publish an inconsistent handoff.
	const after = statSync(source);
	if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) {
		throw new Error("Source session changed during checkpoint; retry after it is idle");
	}
	const dest = resolve(outputDir);
	mkdirSync(dest, { recursive: true, mode: 0o700 });
	const path = join(dest, `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
	const fd = openSync(path, "wx", 0o600);
	try {
		for (const entry of [newHeader, ...compacted] as FileEntry[]) {
			writeFileSync(fd, `${serializeWithImageRefs(entry, path)}\n`);
		}
	} catch (error) {
		closeSync(fd);
		unlinkSync(path);
		throw error;
	}
	closeSync(fd);
	const final = statSync(source);
	if (final.size !== before.size || final.mtimeMs !== before.mtimeMs || final.ino !== before.ino) {
		unlinkSync(path);
		rmSync(`${path}.images`, { recursive: true, force: true });
		throw new Error("Source session changed during checkpoint; discarded incomplete handoff");
	}
	return { path, id, entries: compacted.length };
}
