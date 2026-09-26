# Bounded session prototype (not deployed)

This is an isolated Pi 0.87.0 source copy. It does **not** alter the installed Pi, the live worker, or any existing JSONL.

## What works

- New persisted `image` blocks are stored in `session.jsonl.images/<sha256>` (private 0600 files under a private directory), while JSONL stores `pi-blob://sha256/<digest>`. The in-memory provider message remains base64. Resuming validates and restores the bytes; missing/corrupt/symlinked or overly permissive blobs fail closed. Legacy inline images still load. Moving a session now requires moving its `.images` sibling directory too.
- `createCheckpointSession(source, outputDir)` creates a **new** session with a new ID from the latest Pi compaction system checkpoint, the retained active branch, and subsequent messages. It leaves the original untouched as a cold archive. The new file preserves model-visible context and session title. `createCheckpointSessionIfLarge` supplies a default independent 10 MiB raw-byte trigger; call it only when the old producer is idle. No valid complete checkpoint means a refusal, not a guessed summary. An incomplete last line or a source that changes during the copy also fails closed.
- `replaceStoppedSessionWithCheckpoint(source)` is a separate **stopped-producer-only** primitive. It creates an archived hard link with a `.jsonl.archive` suffix under the session directory's private `.pi-archives/`, preserves older image blobs there, and atomically replaces the original JSONL pathname with a checkpoint carrying the same native session ID. The suffix keeps recursive Botmux transcript discovery from confusing the archived and active copies; the archive remains explicitly openable by Pi. The historical bytes remain accessible at the archive pathname; the next ordinary `--session-id` resume sees a small file. It cannot prove that an external producer or transcript watcher is stopped: the caller must do so first, and must not invoke it against a live worker.
- The old session archive stores historical branches, usage, labels, and extension entries. These are **not all copied** to the new active session: the archive remains their authority. No claim of exact historical `/tree`/accounting equivalence.

## Not yet integrated

**Do not point botmux at this package as-is.** The Pi runtime does not automatically invoke either checkpoint primitive. Botmux needs an idle-only lifecycle gate: drain the current turn and queued user input, stop the worker and watcher, prove it is gone, take a private backup, atomically replace at the stable ID/path, and cold-resume with readback; uncertain delivery or a still-live worker must fail closed. Merely changing `resumeSessionId` on the Pi adapter is unsafe: its existing tests deliberately pin the botmux shell ID, and the transcript bridge needs authoritative ownership. No live handoff has been implemented or tested.

The local blob reference alone does not give a vision model access to an image: Pi restores the bytes for an active model request. Large unreferenced archives are not parsed on resume of the new session. Within a still-large old session, the legacy full loader still reads the whole file once; this prototype requires one offline migration to a checkpoint. The context window is measured in tokens, the archive byte limit separately in bytes; a blanket “2× window” JSONL tail truncation is not supported.

A synthetic 22 MiB old session (no real user data) with a valid compaction was atomically replaced by a ~1 KiB active file. In that local one-off run, cold `SessionManager.open` fell from ~219 ms to <1 ms; producing the checkpoint took ~223 ms, and the active model context before/after compared equal. These numbers are not an end-to-end botmux or provider benchmark. In separate isolated fault-injection runs, SIGKILL immediately before the same-filesystem rename left the 9 MiB original intact; SIGKILL just after it left a ~1 KiB hot session and the byte-identical archived original. This verifies process-crash atomic visibility, **not power-loss durability** (files and parent directories are not fsynced), durable BotMux input admission, or a real running-worker handoff.

## Verification

Run in the isolated checkout:

```sh
cd packages/coding-agent
npx vitest run test/session-manager test/session-checkpoint.test.ts test/session-image-store.test.ts
npm run build:unbundled
```

No real user image, credential, or existing session needs to be copied for these tests.
