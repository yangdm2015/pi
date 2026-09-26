# Bounded session prototype (not deployed)

This is an isolated Pi 0.87.0 source copy. It does **not** alter the installed Pi, the live worker, or any existing JSONL.

## What works

- New persisted `image` blocks are stored in `session.jsonl.images/<sha256>` (private 0600 files under a private directory), while JSONL stores `pi-blob://sha256/<digest>`. The in-memory provider message remains base64. Resuming validates and restores the bytes; missing/corrupt/symlinked or overly permissive blobs fail closed. Legacy inline images still load. Moving a session now requires moving its `.images` sibling directory too.
- `createCheckpointSession(source, outputDir)` creates a **new** session with a new ID from the latest Pi compaction system checkpoint, the retained active branch, and subsequent messages. It leaves the original untouched as a cold archive. The new file preserves model-visible context and session title. `createCheckpointSessionIfLarge` supplies a default independent 10 MiB raw-byte trigger; call it only when the old producer is idle. No valid complete checkpoint means a refusal, not a guessed summary. An incomplete last line or a source that changes during the copy also fails closed.
- The old session file stores historical branches, usage, labels, and extension entries. These are **not all copied** to the new active session: the archive remains their authority. No claim of exact historical `/tree`/accounting equivalence.

## Not yet integrated

**Do not point botmux at this package as-is.** Neither the Pi runtime nor the botmux worker automatically switches to the returned new session ID. Botmux's Pi transcript watcher and session registry would need an idle-only, transactional handoff (bind new ID and transcript path, reconcile pending input, readback, rollback on uncertain delivery) before automatic rotation is safe. A hot-switch in the current Pi process or truncation of an active JSONL would be unsafe.

The local blob reference alone does not give a vision model access to an image: Pi restores the bytes for an active model request. Large unreferenced archives are not parsed on resume of the new session. Within a still-large old session, the legacy full loader still reads the whole file once; this prototype requires one offline migration to a checkpoint. The context window is measured in tokens, the archive byte limit separately in bytes; a blanket “2× window” JSONL tail truncation is not supported.

## Verification

Run in the isolated checkout:

```sh
cd packages/coding-agent
npx vitest run test/session-manager test/session-checkpoint.test.ts test/session-image-store.test.ts
npm run build:unbundled
```

No real user image, credential, or existing session needs to be copied for these tests.
