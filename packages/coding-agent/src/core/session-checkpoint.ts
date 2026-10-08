import { createHash, randomUUID } from "crypto";
import {
	closeSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "fs";
import { basename, dirname, join, resolve } from "path";
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
export function createCheckpointSession(
	sourcePath: string,
	outputDir: string,
	options?: { preserveSessionId?: boolean; parentSession?: string },
): CheckpointSessionResult {
	const source = resolve(sourcePath);
	if (options?.preserveSessionId && dirname(source) === resolve(outputDir)) {
		throw new Error("Preserving a session id requires a private staging directory");
	}
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
	const id = options?.preserveSessionId ? (header as SessionHeader).id : randomUUID();
	const timestamp = new Date().toISOString();
	const newHeader: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id,
		timestamp,
		cwd: (header as SessionHeader).cwd,
		parentSession: options?.parentSession ?? source,
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

/** Keep the botmux/Pi native ID and pathname stable, but only when the owner has
 * already stopped the CLI and its transcript watcher. The archive is linked
 * first; replacing the JSONL itself is a single same-filesystem rename.
 * There is deliberately no automatic live-session trigger here. */
export function replaceStoppedSessionWithCheckpoint(
	sourcePath: string,
	/** Fault injection for isolated crash/rollback tests; not a lifecycle gate. */
	testHooks?: { beforeReplace?: () => void; afterReplace?: () => void },
): {
	path: string;
	archivePath: string;
	entries: number;
} {
	const source = resolve(sourcePath);
	const original = lstatSync(source);
	if (!original.isFile() || original.isSymbolicLink()) throw new Error("Checkpoint source must be a regular file");
	const root = join(dirname(source), ".pi-archives");
	if (existsSync(root)) {
		const stat = lstatSync(root);
		if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
			throw new Error(`Unsafe archive directory: ${root}`);
	} else {
		mkdirSync(root, { mode: 0o700 });
	}
	const archiveDir = mkdtempSync(join(root, "checkpoint-"));
	// Botmux recursively discovers UUID-suffixed .jsonl files. The archive
	// must retain its readable bytes without matching that live-file suffix.
	const archivePath = join(archiveDir, `${basename(source)}.archive`);
	const stageDir = join(archiveDir, "staging");
	mkdirSync(stageDir, { mode: 0o700 });
	try {
		const staged = createCheckpointSession(source, stageDir, {
			preserveSessionId: true,
			parentSession: archivePath,
		});
		const archiveBlobs = `${archivePath}.images`;
		const oldBlobs = `${source}.images`;
		if (existsSync(oldBlobs)) {
			const stat = lstatSync(oldBlobs);
			if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
				throw new Error(`Unsafe session image directory: ${oldBlobs}`);
			mkdirSync(archiveBlobs, { mode: 0o700 });
			for (const name of readdirSync(oldBlobs)) {
				const file = join(oldBlobs, name);
				const blob = lstatSync(file);
				if (!/^[0-9a-f]{64}$/.test(name) || !blob.isFile() || blob.isSymbolicLink() || (blob.mode & 0o077) !== 0)
					throw new Error(`Unsafe session image: ${file}`);
				linkSync(file, join(archiveBlobs, name));
			}
		}
		const newBlobs = `${staged.path}.images`;
		if (existsSync(newBlobs)) {
			if (!existsSync(oldBlobs)) mkdirSync(oldBlobs, { mode: 0o700 });
			for (const name of readdirSync(newBlobs)) {
				const target = join(oldBlobs, name);
				if (existsSync(target)) {
					const stat = lstatSync(target);
					if (
						!stat.isFile() ||
						stat.isSymbolicLink() ||
						createHash("sha256").update(readFileSync(target)).digest("hex") !== name
					)
						throw new Error(`Corrupt session image: ${target}`);
				} else {
					linkSync(join(newBlobs, name), target);
				}
			}
		}
		const unchanged = lstatSync(source);
		if (unchanged.ino !== original.ino || unchanged.size !== original.size || unchanged.mtimeMs !== original.mtimeMs)
			throw new Error("Source session changed; refuse to replace a live transcript");
		linkSync(source, archivePath);
		testHooks?.beforeReplace?.();
		// The original file remains available right up to this atomic rename.
		renameSync(staged.path, source);
		testHooks?.afterReplace?.();
		rmSync(stageDir, { recursive: true, force: true });
		return { path: source, archivePath, entries: staged.entries };
	} catch (error) {
		// Never remove an archive after replacement; callers can inspect and
		// repair a failed post-rename cleanup without losing historical bytes.
		if (existsSync(source) && lstatSync(source).ino === original.ino)
			rmSync(archiveDir, { recursive: true, force: true });
		throw error;
	}
}
