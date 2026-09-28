# Bounded Index Append Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep live Pi index appends proportional to the newly persisted entry, not the full historic index.

**Architecture:** Add a per-session append cursor initialized by a verified cold index or verified fresh build. On normal append use the cursor to validate index/source continuity and append a single hashed journal record; on mismatch rehydrate authoritative JSONL and rebuild the index. Cold recovery continues its existing full validation.

**Tech Stack:** TypeScript, Node fs/crypto, vitest; Pi 0.87.1 selective-session fork.

---

### Task 1: Cursor contracts and red tests

**Files:** `packages/coding-agent/src/core/session-offset-index.ts`; `packages/coding-agent/test/session-offset-index.test.ts`.

- [ ] Test cursor creation after healthy `readOffsetIndex`, two appends, cold validation, index replacement/truncation, source tail mutation, and a long history ensuring a normal append never calls the full `readOffsetIndex` path.
- [ ] Run `../../node_modules/.bin/vitest run test/session-offset-index.test.ts`; expect new cases to fail.

### Task 2: Cursor implementation

**Files:** `packages/coding-agent/src/core/session-offset-index.ts`.

- [ ] Implement cursor seeding and a separate cursor-based append path with sidecar identity/size checks, source old-anchor/identity and new-line validation; update cursor only after complete journal write. Preserve the old API for legacy callers. Abort safely on all mismatches.
- [ ] Run targeted tests until green; compare small/large synthetic history timing without interpreting timings as a response-speed guarantee.

### Task 3: SessionManager wiring/failure recovery

**Files:** `packages/coding-agent/src/core/session-manager.ts`; `packages/coding-agent/test/session-selective-recovery.test.ts`.

- [ ] Seed the per-instance cursor on verified cold load and fresh build. Use the cursor for each new entry. If the fast path fails, reload authoritative JSONL regardless of whether current memory was selective or previously complete, then rebuild its index; keep valid but unindexable sources usable in full-history mode (never silently pretend the index is healthy). Reseed after successful rebuild.
- [ ] Add multi-session same-file tests, sidecar mutation and torn journal tests. Preserve same path/ID and old JSONL bytes outside the newly appended entry.

### Task 4: Verify and release review

- [ ] Run relevant session tests, TypeScript build/lint, and isolated long append/cold-recovery smoke using temporary JSONL only.
- [ ] Review for crash/external-writer races, credential leaks and card estimator compatibility. Commit feature on `fix/append-index-constant-time`, not fork main. No live rollout until acceptance and idle-window safety review.
