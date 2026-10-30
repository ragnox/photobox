# Native backup API: verified reception and export

The host implements **milestones 1 and 2** of [the phone backup plan](phone-backup-plan.md):
resumable reception, full-hash-aware indexing, and verified automatic export.
There is no Android backup client or phone cleanup flow yet.

## Connection and authorization

Start `photobox serve --listen <address>` (or `npm start -- --listen 0.0.0.0`).
Use the paired **HTTPS** listener, normally port 4568. Trust the host's CA or use a
trusted certificate. Never disable certificate verification in a native client.

To export received originals automatically, select an **existing** destination:

```sh
npm start -- --listen 0.0.0.0 --backup-dir ~/Photos
```

`PHOTOBOX_BACKUP_DIR` is the equivalent environment setting. Received originals are
indexed even without a destination; `exported` then stays false. This queue exports
phone uploads, not every unrelated source folder in the library. Use `photobox export`
for a complete library export. Keep the destination setting on subsequent launches.

Pair through `POST /api/pair` using a one-time code generated on the computer.
Use the returned token as `Authorization: Bearer <token>` on **every** upload and
receipt request, including HEAD/OPTIONS/DELETE. A browser's pairing cookie alone
is insufficient. Revoking the device denies subsequent requests without deleting
its originals. Upload IDs and receipt queries are scoped to the owning token.

On the computer, choose **Connect a phone → Photobox for Android**. Each pairing
link now has a `native` object containing `payload` (versioned JSON) and `qr` (SVG).
The payload includes the host address, one-time code, expiry and public trust
certificate DER/base64 with full SHA-256. Photobox's own certificate uses `kind: ca`;
a user-supplied certificate uses `kind: certificate` and pins that exact leaf.
The Android client validates this anchor and verifies TLS/hostname before redeeming
the code. No unverified certificate download is needed. Browser QR links/cookies
remain separate and compatible.

`GET /api/backup/capabilities`, with the device bearer token, returns protocol
`version: 1`, `tusVersion: "1.0.0"`, `maxFileBytes`, and supported filename
`extensions`. The client reads this before discovery/upload to report unsupported
formats or oversized originals without repeatedly attempting binary writes.

## Resumable uploads

`/api/uploads` implements tus 1.0.0 with creation, creation-with-upload and
termination of **unfinished or rejected** sessions. Lengths must be known and
nonzero. Deferred lengths, concatenation and automatic expiration are unsupported.
The client must persist its upload URL before transferring chunks. If creation's
response is lost, retrying creation may leave another unfinished reservation; there
is no idempotent creation key or session-listing API yet.

### Create

```http
POST /api/uploads
Authorization: Bearer <token>
Tus-Resumable: 1.0.0
Upload-Length: 123456
Upload-Metadata: filename <base64>,sha256 <base64>,capturedAt <base64>,mediaStoreId <base64>
```

Metadata values use the standard tus base64 encoding of UTF-8 strings:

| Key | Required | Meaning |
| --- | --- | --- |
| `filename` | Yes | Plain filename with a supported photo/video extension; at most 240 UTF-8 bytes; no directories, hidden names, controls or reserved path characters |
| `sha256` | Yes | Full original-file SHA-256, 64 lowercase hexadecimal characters |
| `capturedAt` | No | ISO capture timestamp with `Z` or an explicit offset; up to milliseconds |
| `mediaStoreId` | No | Opaque phone identifier, at most 128 characters; not a content identity |

Unknown keys are rejected. The server generates a random ID; callers cannot choose
the storage path. Response: `201`, with a relative `Location: /api/uploads/<id>`.

### Resume and append

`HEAD /api/uploads/<id>` returns `Upload-Offset` and `Upload-Length`.
Resume at the server's offset, not the last client-side progress estimate:

```http
PATCH /api/uploads/<id>
Authorization: Bearer <token>
Tus-Resumable: 1.0.0
Upload-Offset: 65536
Content-Type: application/offset+octet-stream

<original bytes starting at offset 65536>
```

Successful chunks return `204` and the new offset. At the full length, the server
streams SHA-256, flushes the file, moves it into the inbox and persists the receipt.
There is no transcoding. A mismatched digest returns `422`; cancel that session and
create a new one. Incorrect offsets return `409` without overwriting existing bytes.

A full tus offset is **not** a backup receipt. If the final response was lost, HEAD
or the receipt check recovers verification/publication from the persisted bytes.
For received uploads, HEAD describes the completed transfer; use a receipt check
to detect an inbox file that has since been removed or corrupted.

### Cancel

`DELETE /api/uploads/<id>` with the bearer and tus headers removes partial bytes
and releases the device's reservation. It can also cancel rejected transfers.
Received originals are immutable through this API: PATCH and DELETE return `409`.
Cancelled/foreign/unknown IDs return `404`.

## Check current backup state

```http
POST /api/assets/check
Authorization: Bearer <token>
Content-Type: application/json

{"sha256":["<64 lowercase hex characters>"]}
```

At most 100 hashes per request. The response preserves request order:

```json
{
  "assets": [
    { "sha256": "<hash>", "received": true, "indexed": true, "exported": true }
  ]
}
```

`received: true` means a complete original belonging to this device was re-read
and its full digest matched. Missing, modified and rejected originals return false.
`indexed: true` additionally requires a file/media association with that full hash.
`exported: true` requires a persisted export receipt, the configured destination's
marker, and a fresh full-hash/size check of a regular destination file. Symlinks,
corrupt files, missing files and unavailable/replaced destinations fail closed.
All three fields are false when reception cannot be confirmed. Checking another
device's hash reveals no receipt for that device.

Checks are point-in-time evidence, not a promise against future disk failure.
Reception alone is insufficient for phone cleanup. The future Android cleanup flow
must recheck host proof and the phone's current content/version before system-confirmed
deletion; these endpoints themselves delete no phone originals.

## Automatic indexing and export

- A persistent received-upload ledger feeds a serialized, retryable queue. Work
  resumes at host startup; failures retry about once per minute.
- Managed inbox sources admit only verified uploads. Ordinary scans/watchers do
  not import arbitrary files into an inbox source. Removing managed sources through
  the source API is rejected. Originals remain in the inbox.
- New/changed files are fully hashed; legacy candidate identities are verified
  before deduplication. Background source scans backfill legacy file identities in
  bounded workers. Old media IDs/cache keys remain where the bytes still match;
  sampled collisions split into separate full-content identities and cache keys.
- Export paths use the photo's resolved local capture date. EXIF retains priority;
  an explicit phone capture timestamp is preserved as `dateSource: capture` when
  EXIF does not supply a better instant. A missing capture time cannot replace a
  stronger existing date with the reception time.
- Partial copies are full-hash verified and flushed before atomic no-overwrite
  publication. Reused/moved files are reverified and their directory entries flushed
  too. The version-1 manifest gains additive `sha256` and `bytes` fields. Old
  manifests still import; new manifests identify moved files by full hash.
- Atomic no-overwrite publication requires hard-link support on the destination
  filesystem (for example APFS/ext4). Unsupported destinations report a failure and
  retain the inbox original. Separate source and export disks are supported because
  publication links the temporary **destination copy**, not the source file.
- A hidden `.photobox-backup.json` marker identifies the chosen destination.
  The destination and Photobox's data directory must be separate, non-overlapping trees.
  Its expected ID is persisted in SQLite. Missing roots are never recreated;
  a previously configured directory with a missing/changed marker is never adopted
  as a fresh destination. This handles readable, empty mount points after unplugging.
- A changed/missing copy invalidates proof and queues repair. Moved files are found
  by full hash. Corrupt/unrecognized files are preserved; a good original gets a
  new free filename. Interrupted publications are reused rather than copied again.
- Local `/api/status` and the sidebar show received, indexed, export-verified,
  processing and failure state. Per-upload errors are persisted for retry. Favorites
  changed through the API refresh exported metadata too.

## Storage and limits

- Partial bytes: `~/.photobox/uploads/<id>`.
- Received originals: `~/.photobox/inbox/<device-id>/YYYY/MM/<id>/<filename>`.
- Inbox folders use the UTC month of `capturedAt`, or reception month if absent;
  the plain-files export independently uses the photo's resolved **local** month.
- SQLite stores ownership, original name, size, expected hash and receipt state.
  Actual partial-file length is the resumable offset, including after restart.
- Verified inbox originals are indexed as managed sources. Keep the inbox and
  database when backing up host data; automatic inbox cleanup is not implemented.
- Moving/deleting inbox files invalidates reception checks; path-independent
  discovery and inbox retention are future work.

Limits can be set with environment variables before starting Photobox:

| Variable | Default |
| --- | --- |
| `PHOTOBOX_UPLOAD_MAX_BYTES` | 50 GiB per original |
| `PHOTOBOX_UPLOAD_DEVICE_QUOTA_BYTES` | 500 GiB per paired token |
| `PHOTOBOX_UPLOAD_MIN_FREE_BYTES` | 1 GiB disk reserve |

Values are integer bytes. Quota includes received, pending and rejected sessions;
cancel unfinished/rejected sessions to release reservations. Disk admission reserves
remaining pending bytes across all devices and is rechecked before each PATCH.
Re-pairing creates a new quota namespace; this is not a global host storage cap.

Typical failures: `400` metadata/receipt input, `401` missing/revoked bearer,
`404` unknown or foreign upload, `409` offset/immutability conflict, `413` size/quota,
`415` wrong content type, `422` digest mismatch, `507` insufficient free space.
Errors from the tus handler are plain text; outer API validation errors are JSON.

## Verification

`node --test test/uploads.test.js` uses synthetic originals over real HTTPS. It
covers resumption/restart, an interrupted request, cross-device isolation and
revocation, metadata/length limits, concurrent quota reservations and chunk writes,
disk reserve, wrong hashes, corrupt/missing files and receipt-commit recovery.
The tests exercise production startup as well as the scoped upload service.

`node --test test/backup.test.js test/export.test.js` also covers real HTTPS
upload-to-export proof, legacy schema/cache migration, sampled collisions, renamed
manifest re-import, corruption and repair, missing/replaced destinations, symlink
rejection, source changes during copy, and export-receipt recovery after restart.
