import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildOffsetIndex, readOffsetIndex } from "../src/core/session-offset-index.js";
import type { FileEntry } from "../src/core/session-manager.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pi-offset-index-")); dirs.push(dir);
  const file = join(dir, "session.jsonl");
  const header = { type: "session", version: 3, id: "session-a", cwd: dir, timestamp: "2026-09-27T00:00:00Z" } as FileEntry;
  const first = { type: "message", id: "msg-1", parentId: null, timestamp: "2026-09-27T00:00:01Z", message: { role: "user", content: "A".repeat(256 * 1024), timestamp: 1 } } as FileEntry;
  const other = { type: "message", id: "msg-2", parentId: "msg-1", timestamp: "2026-09-27T00:00:02Z", message: { role: "user", content: "B", timestamp: 2 } } as FileEntry;
  const entries = [header, first, other];
  writeFileSync(file, `${entries.map(e => JSON.stringify(e)).join("\n")}\n`);
  return { dir, file, entries };
}

describe("session offset metadata index", () => {
  it("records byte-exact ranges without storing old message bodies", () => {
    const { file, entries } = fixture();
    expect(buildOffsetIndex(file, entries)).toBe(true);
    const index = readOffsetIndex(file);
    expect(index?.id).toBe("session-a");
    expect(index?.records.map(r => [r.id, r.parentId, r.type])).toEqual([
      ["msg-1", null, "message"], ["msg-2", "msg-1", "message"],
    ]);
    expect(index?.records[0]?.start).toBe(Buffer.byteLength(`${JSON.stringify(entries[0])}\n`));
    expect(index?.records.at(-1)?.end).toBe(statSync(file).size);
    expect(readFileSync(`${file}.idx`, "utf8")).not.toContain("A".repeat(128));
    expect(statSync(`${file}.idx`).mode & 0o077).toBe(0);
  });
  it("fails closed to the caller on wrong identity, stale source, corrupt index, or symlink", () => {
    const { file, entries } = fixture();
    expect(buildOffsetIndex(file, entries)).toBe(true);
    const index = readOffsetIndex(file)!;
    writeFileSync(`${file}.idx`, JSON.stringify({ ...index, id: "wrong-id" }), { mode: 0o600 });
    expect(readOffsetIndex(file)).toBeNull();
    expect(buildOffsetIndex(file, entries)).toBe(true);
    writeFileSync(file, `${readFileSync(file, "utf8")}\n`);
    expect(readOffsetIndex(file)).toBeNull();
    writeFileSync(file, `${entries.map(e => JSON.stringify(e)).join("\n")}\n`);
    expect(buildOffsetIndex(file, entries)).toBe(true);
    chmodSync(`${file}.idx`, 0o644);
    expect(readOffsetIndex(file)).toBeNull();
    chmodSync(`${file}.idx`, 0o600);
    const copy = `${file}.index-copy`;
    renameSync(`${file}.idx`, copy);
    symlinkSync(copy, `${file}.idx`);
    expect(readOffsetIndex(file)).toBeNull();
  });
  it("rejects incomplete source lines and invalid indexes without editing the original", () => {
    const { file, entries } = fixture();
    const before = readFileSync(file);
    expect(buildOffsetIndex(file, entries)).toBe(true);
    const index = readOffsetIndex(file)!;
    writeFileSync(`${file}.idx`, JSON.stringify({ ...index, records: [{ ...index.records[0], end: index.records[0]!.end + 1 }, index.records[1]] }), { mode: 0o600 });
    expect(readOffsetIndex(file)).toBeNull();
    expect(readFileSync(file)).toEqual(before);
    writeFileSync(file, Buffer.concat([before, Buffer.from("partial")]));
    expect(readOffsetIndex(file)).toBeNull();
  });
});
