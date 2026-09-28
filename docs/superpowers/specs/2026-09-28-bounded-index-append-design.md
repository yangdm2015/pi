# Bounded live append of the selective-session index (2026-09-28)

## User-approved scope

Keep the same Pi session ID, append-only authoritative JSONL, indexed selective cold recovery and existing fallback. Remove the newly introduced full `.idx` plus `.idx.delta` parse/check on **every** persisted entry in a live process; do not remove the full index check at a cold open. Do not claim that this change, by itself, fixes the original unconfirmed writing-group stall or makes a model API request incremental.

## Diagnosis

`SessionManager._appendEntry` currently calls `appendOffsetIndex`, which calls `readOffsetIndex(file, true)` and re-parses the snapshot and entire cumulative delta, including the hash chain and record ID scan, for every new JSONL line. For a live sample with ~4,988 index records that check took 23–27 ms/read; the cold active context held ~263 entries. This is unnecessary per-entry O(total index history) work introduced by the fork, but it is not evidence that the historical stall was caused by the index (the original complaint predates it).

## Approach and invariants

A private **per-SessionManager append cursor** remembers the last index checksum, indexed source offset and boundary anchor, and identity/size/mtime/ctime of the snapshot and journal files. It is created only after a full, successful `readOffsetIndex`, including a fresh index build. On append, check unchanged snapshot/journal identity and size, source identity and old boundary; parse only the one newly written source line and append one chained journal record. Advance the cursor only after a complete successful write. If any check fails, discard the cursor, reload the authoritative JSONL even when the manager previously held full history, and rebuild the index if the source format supports it. Valid but unindexable source files continue in full-history mode without rejecting appended messages; a failure must never silently skip a source entry. Never share cursors between session managers or trust one across process restarts. Existing `appendOffsetIndex` public behavior without a cursor remains available for compatibility.

Alternatives rejected: retain the full per-entry check (unbounded work), periodically rewrite the full snapshot (large write amplification), or truncate/rotate the original JSONL (breaks the approved same-ID/same-path/history guarantee). A changed old source byte outside the boundary cannot be authenticated by this lightweight index, just as the original anchor-based cold validation cannot prove every old source byte unchanged; this design preserves the existing append-only assumption and detects ordinary file identity, tail and sidecar changes.

## Acceptance

Isolated tests cover consecutive append without invoking full `readOffsetIndex`, restart with full verification, missing/corrupt/replaced/truncated metadata, external source append, torn journal, independent session managers, long synthetic history, and unchanged selected model context. Compare live-append work at small and large history; report actual timings rather than performance promises. Keep original JSONL untouched in all production observations. No bot rollout until unit/build/smoke results and an idle-window release review. Explicit full-history APIs and compaction/model behavior remain out of scope.
