# Phone backup: implementation plan

Android first: a small native backup app sends original files to the existing
Photobox host over paired HTTPS. The existing web app provides browsing initially.
This is the executable breakdown of [the Android roadmap](android-plan.md).

## Contract

- Preserve original bytes, including GPS, motion-photo payloads, HDR gain maps,
  RAW files and videos. Do not transcode uploads.
- Phone deletions never delete host files. Changed phone content is a new version.
- Resumption works after network loss, app termination and host restart.
- Distinguish **received and verified**, **indexed**, and **export verified**.
  Neither an HTTP success nor a thumbnail means a photo is safely backed up.
- Use full SHA-256 plus byte length for backup identity. The existing sampled
  fingerprint is only an indexing optimization, never proof of an identical copy.
- Freeing phone space is a separate, explicitly initiated operation, introduced
  only after the backup path has been tested on a real phone.

## Starting point (2026-10-25)

The host already has paired HTTPS, revocable bearer tokens, SQLite, folder
watching, media indexing, export and a browsing PWA. There is no Android project.
The browser pairing QR carries a URL and code; its certificate fingerprint is
returned separately, not embedded in the QR. Indexing/export deduplicate using
sampled fingerprints and cannot yet issue full-content backup receipts.

## Milestone 1 — Verified, resumable reception

Files: `src/uploads.js`, `src/server.js`, `src/db.js`, `src/config.js`, upload tests.

1. Integrate maintained `@tus/server` and `@tus/file-store` at `/api/uploads`.
   Mount after device authentication and before JSON parsing, so binary writes
   are confined to the upload routes. Require a bearer token for this native API;
   browser cookies alone do not authorize binary uploads.
2. Persist upload ownership, expected size/hash, original filename, optional
   capture timestamp and MediaStore ID in SQLite. Associate ownership with the
   immutable token hash, not a reusable SQLite device ID.
3. Require known nonzero lengths; reject unsafe filenames, unsupported extensions,
   deferred lengths and excessive metadata. Generate random upload IDs on the host.
4. Enforce maximum item size, per-device reserved-byte quota and available-disk
   reserve. Serialize reservations and mutations. Allow cancellation of unfinished
   sessions, but never use upload termination to delete a verified original.
5. Keep partial bytes in `~/.photobox/uploads/`. Full-hash verification and file
   flushing precede atomic publication into
   `~/.photobox/inbox/<device>/<YYYY>/<MM>/<upload-id>/<original-name>`.
   Until capture metadata is interpreted during indexing, this date is the supplied
   timestamp's UTC month, or the reception month when omitted.
6. Flush the published directory entry before committing a receipt. Recover a
   complete partial file or a rename interrupted before the database commit.
   An invalid hash produces no positive receipt.
7. Provide authenticated `POST /api/assets/check` for batches of SHA-256 values.
   Scope queries to the caller's uploads; re-read/hash the stored bytes before
   confirming reception. Initially return `indexed: false`, `exported: false`.
8. Do not feed the inbox into the sampled-fingerprint indexing/export pipeline
   until milestone 2 makes that pipeline collision-safe.

Acceptance: synthetic uploads survive interrupted requests and a host restart;
wrong offsets, concurrent writes, wrong hashes, unsafe paths, resource limits,
cross-device requests, token revocation, missing files and changed file bytes
cannot create a false receipt. Publication-boundary recovery is tested.

## Milestone 2 — Verified library export

1. Add full SHA-256 identity to files/assets with an additive database migration.
    Full-hash existing candidates needed for comparison. Background source scans
    backfill other legacy file identities with bounded workers; unchanged files
    with known identities and matching high-resolution change stamps stay incremental.
2. Resolve sampled-fingerprint collisions without merging different originals.
   Keep thumbnail cache keys and legacy manifests compatible during migration.
3. Register verified inbox files as managed sources and index them. Preserve the
   upload's original filename, capture metadata and device association. Indexing
   failure is visible and retryable; it does not lose the received original.
4. Add an automatic export queue with one configured plain-files destination.
   Copy via partial files, verify destination SHA-256, flush files/directories,
   then commit export receipts. Reused destination files need the same proof.
5. Reconcile receipt state after interruption. Missing, changed or unavailable
   export files cannot remain eligible for phone cleanup. Retain inbox originals;
   postpone automated inbox retention/garbage collection.
6. Show received / awaiting indexing / awaiting export / export verified / failed
   separately. Surface disk-full and unavailable destinations.

Acceptance: two files with identical size and sampled prefix/suffix but different
middle bytes both survive import/export. Full-byte corruption, deleted exports,
stale manifests and crashes at copy/rename/receipt boundaries never yield a false
export receipt. Export/re-import preserves existing metadata and live-photo pairs.

## Milestone 3 — Minimal Android backup app

Keep `android/` in this repository while the API evolves. Kotlin, Jetpack Compose,
MediaStore, Room, WorkManager, an HTTP client and a compatible tus client; no Google
Play Services dependency.

1. Native QR payload: host address, short-lived pairing code, and CA fingerprint
   (or defined trust information for a user-supplied certificate). Authenticate
   the TLS connection against that trust anchor before exchanging the code. Store
   the device token encrypted with a key protected by Android Keystore. Keep the
   existing browser pairing flow compatible.
2. Camera folder selected by default; optional media folders. Handle full versus
   selected-photo access, revoked permissions and removable volumes explicitly.
   Request `ACCESS_MEDIA_LOCATION` and use `MediaStore.setRequireOriginal()` where
   needed so hashing and uploading see the original EXIF bytes.
3. Persist discovery/version information, SHA-256, queue state, upload URL/offset
   and host receipts in Room. Observe MediaStore changes and reconcile periodically;
   a content observer alone is insufficient when the app has not been running.
4. Hash only stable items and verify the source did not change during reading.
   Treat edits as new versions. Stream bounded chunks and resume from the server's
   offset. Reconcile completed uploads whose final HTTP response was lost.
5. WorkManager handles deferred work and constraints: unmetered network by default,
   battery not low, charging optional. Design foreground transfers around current
   Android execution/time limits, with progress and cancellation. Never promise
   an exact background execution time.
6. Screens: Connect, backup folders/settings, pending/uploading/verified/failed,
   last success, Back up now, Pause. Link to the existing browser for browsing.

Acceptance: a real Android phone backs up a mixed 10 GB library with matching
full hashes and intact GPS. Resume across airplane mode, process termination,
host restart and reboot. Test limited permissions, edits and Android execution
limits. This is the first end-to-end backup release; phone deletion is absent.

## Milestone 4 — User-initiated free up space

1. Require fresh host confirmation of a full-hash-verified export and verify the
   local MediaStore item still represents the same bytes/version immediately
   before selecting it for cleanup. Fail closed on offline/unknown state.
2. Show exact items and reclaimable space. Use Android's system-confirmed trash
   request where supported, or an explicitly confirmed delete flow. Do not promise
   recovery for permanent deletion or for providers that do not support trash.
3. Never delete automatically, delete an unconfirmed version, or propagate phone
   deletion to the host. Keep receipt semantics distinct from off-site backup:
   inbox plus export on one disk is not protection from that disk failing.

Acceptance: deletion candidates exclude changed, unexported, stale, corrupt and
unreachable assets. Test edits between listing and confirmation and restored
trash items on real devices.

## Later

Native browsing/offline thumbnails, XMP, search, face grouping, Google migration
tooling and iPhone backup. The host protocol can support another client later;
iOS background execution and PhotoKit require their own implementation plan.

## Progress

- [x] Inspect the existing host and record the incremental plan.
- [x] Milestone 1: verified resumable host reception and recovery tests.
  See [the native backup API](backup-api.md) and `test/uploads.test.js`.
- [x] Milestone 2: collision-safe indexing and verified automatic export.
  Configure an existing `--backup-dir` (or `PHOTOBOX_BACKUP_DIR`).
  See `src/backup.js`, `test/backup.test.js`, and [the API](backup-api.md).
- [ ] Milestone 3: Android backup app and real-phone acceptance tests.
  Client implementation is in [`android/`](../android/README.md): secure native
  QR trust bootstrap, MediaStore discovery/original reads, a versioned Room queue,
  WorkManager constraints and resumable HTTP transfers. Physical-device acceptance
  remains open in [the verification matrix](android-verification.md).
  Pixel 10 Pro / Android 17 smoke verification now passes install/launch, an exact-byte
  8 MB JPEG transfer over Wi-Fi, EXIF/GPS retention and a persisted verified export
  receipt. Android 17 foreground-start denial was found and fixed. The mixed 10 GB,
  format, interruption and execution-limit acceptance matrix is still open.
- [ ] Milestone 4: explicitly confirmed phone cleanup.
