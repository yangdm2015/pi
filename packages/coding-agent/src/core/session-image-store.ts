import { createHash, randomUUID } from "crypto";
import {
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "fs";
import { join } from "path";

/** Only session-owned content blocks are rewritten; tool metadata is left untouched. */
type JsonObject = Record<string, unknown>;
const PREFIX = "pi-blob://sha256/";
const REF = /^pi-blob:\/\/sha256\/([0-9a-f]{64})$/;
const VALID_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function blobDir(sessionFile: string): string {
	return `${sessionFile}.images`;
}

function checkDir(dir: string): void {
	if (existsSync(dir)) {
		const stat = lstatSync(dir);
		if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0)
			throw new Error(`Unsafe session image directory: ${dir}`);
		return;
	}
	mkdirSync(dir, { mode: 0o700 });
}

function imageBlocks(entry: JsonObject, visit: (block: JsonObject) => void): void {
	const lists: unknown[] = [];
	if (entry.type === "message") lists.push((entry.message as JsonObject | undefined)?.content);
	if (entry.type === "custom_message") lists.push(entry.content);
	if (entry.type === "context_edit") lists.push((entry.replacement as JsonObject | undefined)?.content);
	for (const list of lists) {
		if (!Array.isArray(list)) continue;
		for (const block of list) {
			if (block && typeof block === "object" && (block as JsonObject).type === "image") visit(block as JsonObject);
		}
	}
}

/** Persist images as content-addressed files, without changing the in-memory message. */
export function serializeWithImageRefs(entry: object, sessionFile: string): string {
	let clone: JsonObject | undefined;
	const original = entry as JsonObject;
	imageBlocks(original, (block) => {
		const data = block.data;
		if (typeof data !== "string" || data.length === 0 || !VALID_BASE64.test(data)) return;
		const bytes = Buffer.from(data, "base64");
		const hash = createHash("sha256").update(bytes).digest("hex");
		const dir = blobDir(sessionFile);
		checkDir(dir);
		const target = join(dir, hash);
		if (existsSync(target)) {
			const stat = lstatSync(target);
			if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
				throw new Error(`Unsafe session image: ${target}`);
			if (createHash("sha256").update(readFileSync(target)).digest("hex") !== hash)
				throw new Error(`Corrupt session image: ${target}`);
		} else {
			const temp = join(dir, `.${hash}.${randomUUID()}`);
			const fd = openSync(temp, "wx", 0o600);
			try {
				writeFileSync(fd, bytes);
			} finally {
				closeSync(fd);
			}
			try {
				renameSync(temp, target);
			} finally {
				if (existsSync(temp)) unlinkSync(temp);
			}
		}
		if (!clone) clone = structuredClone(original);
		// Match the block in its owning list by array position, never by payload text.
		const oldLists: unknown[] = [];
		const newLists: unknown[] = [];
		imageBlocks(original, (b) => oldLists.push(b));
		imageBlocks(clone, (b) => newLists.push(b));
		const index = oldLists.indexOf(block);
		(newLists[index] as JsonObject).data = `${PREFIX}${hash}`;
	});
	return JSON.stringify(clone ?? entry);
}

/** Fail closed if a referenced file is missing, symlinked, or corrupt. */
export function hydrateImageRefs<T extends object>(entry: T, sessionFile: string): T {
	imageBlocks(entry as JsonObject, (block) => {
		const match = typeof block.data === "string" ? REF.exec(block.data) : null;
		if (!match) return;
		const dir = blobDir(sessionFile);
		const dirStat = lstatSync(dir);
		if (dirStat.isSymbolicLink() || !dirStat.isDirectory() || (dirStat.mode & 0o077) !== 0)
			throw new Error(`Unsafe session image directory: ${dir}`);
		const file = join(dir, match[1]!);
		const stat = lstatSync(file);
		if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
			throw new Error(`Unsafe session image: ${file}`);
		const bytes = readFileSync(file);
		if (createHash("sha256").update(bytes).digest("hex") !== match[1])
			throw new Error(`Corrupt session image: ${file}`);
		block.data = bytes.toString("base64");
	});
	return entry;
}
