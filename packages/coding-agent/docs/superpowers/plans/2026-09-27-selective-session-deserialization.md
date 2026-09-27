# Selective Session Deserialization Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On healthy Pi 0.87.1 cold recovery, JSON-parse only the original JSONL bodies needed by the active branch/context; allow full-load-and-rebuild when auxiliary index is absent or invalid.

**Architecture:** Add a private, versioned append-only offset/metadata index of the authoritative JSONL. The index describes every persisted entry without storing old message/tool bodies. Rebuild from a validated full load if absent or inconsistent. On a healthy cold open, walk metadata from the last leaf to root, resolve compaction and context state, seek/parse only selected original lines, and preserve the existing in-memory SessionManager API. The old `.hot` remains readable as an auxiliary legacy artifact but is not the healthy indexed load path. Never rewrite live JSONL or change the logical session ID.

**Tech Stack:** TypeScript, Node fs synchronous positional reads, Pi SessionManager and Vitest; Node 24 for the repository build.

**Design:** `packages/coding-agent/docs/superpowers/specs/2026-09-27-selective-session-deserialization-design.md`.

---

### Task 1: Index format, validation, and failure-mode tests

**Files:** Create `packages/coding-agent/src/core/session-offset-index.ts`; create `packages/coding-agent/test/session-offset-index.test.ts`.

- [ ] Write failing tests for a private v1 index containing source identity, ID, exact indexed end offset, 8 KiB boundary anchor, ordered per-entry `{id,parentId,type,start,end}` and small accounting/state metadata. Reject wrong ID/dev/ino, source size change, bad anchor, symlink, permissive mode, partial last line, overlapping/noncontiguous ranges and unsupported version. Include one large irrelevant body and assert the *index reader* never reads it.
- [ ] Run `cd packages/coding-agent && npx vitest run test/session-offset-index.test.ts` and confirm the intended failures.
- [ ] Implement `rebuildOffsetIndex(file, validatedEntries)` and `loadOffsetIndex(file)`; the initial rebuild is allowed to read the whole file but must check line boundaries and identity before publishing a 0600 temp file by atomic rename. The metadata builder receives already-parsed `FileEntry`s on append/rebuild; don't parse bodies merely to get the next offset. Index reads must be bounded and validate size/identity before yielding offsets. Do not promise power-loss durability from rename alone.
- [ ] Re-run the focused tests and `npx tsc --noEmit`; commit index unit only.

### Task 2: Selected-line loader and equivalence

**Files:** Modify `packages/coding-agent/src/core/session-offset-index.ts`; extend `packages/coding-agent/test/session-offset-index.test.ts`.

- [ ] Write a fixture with a real compaction, retained messages before it, a large abandoned branch after it, model/thinking changes, labels, usage, `context_edit`, and a newer active leaf. Instrument JSON parse calls or positional reads to assert the unrelated **message body** is not deserialized.
- [ ] Compare selected model messages, leaf, header, labels, title, usage totals and compaction count against `loadEntriesFromFile` plus `buildContextEntries` / `buildSessionContext`. If any cold metadata cannot be reconstructed from the index without an old body, add the minimal metadata field explicitly rather than silently changing the result.
- [ ] Implement `loadSelectedEntriesFromIndex(file, index)` using indexed parent traversal, latest compaction plus `firstKeptEntryId`, context edits and required state entries; read original JSONL with positional offsets and require each parsed ID/type/parent to match indexed metadata. Do not parse unrelated bodies. Build a synthetic/reparented active branch using the established `_maybeSaveHotSession` ordering (kept entries before compaction, then suffix); track cold usage/count separately. If metadata cannot prove an equivalent context, return `null` for the permitted full fallback.
- [ ] Test a no-compaction active branch (all its genuinely needed bodies are read), empty/multi-root sessions and an oversized *needed* message. Commit selected loader.

### Task 3: Wire cold and warm paths without modifying the original file

**Files:** Modify `packages/coding-agent/src/core/session-manager.ts`; extend `packages/coding-agent/test/session-manager/*.test.ts` or create `packages/coding-agent/test/session-selective-recovery.test.ts`.

- [ ] Test cold open with a valid index: same session ID/path/leaf/context/usage as full load, and no JSON parsing of an unrelated large body. Test absent, stale, damaged and crash-between-JSONL-and-index: full authoritative load once, rebuild index, then selective second cold open.
- [ ] In `_setSessionFile`, try validated index first; on failure load authoritative JSONL (not a mixed stale index) and rebuild. On `_persist` append source first, then append matching metadata so a crash cannot make the index run ahead. On `_rewriteFile`/legacy migration invalidate index before publication; full-history actions may materialize explicitly but ordinary context building must not. Preserve lazy image references.
- [ ] Run `npx vitest run test/session-offset-index.test.ts test/session-selective-recovery.test.ts test/session-hot-store.test.ts test/session-image-store.test.ts test/session-manager` plus `npx tsc --noEmit`, fix failures, commit integration.

### Task 4: Crash/race/security tests and honest metrics

**Files:** Extend the new tests; update `packages/coding-agent/docs/session-hot-store.md`; later, separately, BotMux `src/services/pi-resume-size.ts` and its test.

- [ ] Inject stopped writes around source/index updates and atomic rebuild rename; verify stale state falls back instead of losing entries. Test source inode replacement, same-size tamper at the boundary, symlink, permissions, incomplete line and branch switching to archived entries. Compare tree/history export on demand with full source; assert no normal cold path calls `_materializeFullHistory`.
- [ ] Measure actual selected JSONL body bytes and metadata-index bytes separately. The existing BotMux work-card `hot size + JSONL tail` metric describes the old loader: do not ship a new Pi runtime while presenting that number as new selective-body parse bytes. Update BotMux estimator in its own isolated branch and verify card POST/PATCH when Pi loader is ready.
- [ ] Run relevant Pi tests and Node 24 root build; run broader suites and report unrelated failures distinctly. Run a fake-worker same-ID cold-recovery trial on a disposable session and compare context/cost/leaf before and after; never rewrite the live Worker7 JSONL.
- [ ] Only after independent review and explicit rollout approval, publish to `yangdm2015/pi` feature branch and stage a new immutable launcher. Do not change running PTYs or production BotMux daemon as a side effect of tests.

## Review checkpoint (isolated only)

The first implementation milestone is committed through `ae3836f0d`: healthy indexed cold opens parse selected JSONL bodies; an absent, torn or damaged index permits full recovery/rebuild. Related tests currently pass (195 passed, 10 skipped) and the coding-agent unbundled build succeeds. **This is not completion or rollout approval.** The current `.idx` is an atomically re-published JSON metadata snapshot after each append, not yet the planned truly append-only incremental metadata index; its metadata parse/write cost grows with history length. Before shipping, either implement the append-only index journal or obtain an explicit design change, test the broader branch/context-edit/extension matrix and crash races, and update the BotMux card estimate (old `.hot + suffix` is no longer truthful for a healthy indexed Pi). Keep this section until those gates are resolved.
