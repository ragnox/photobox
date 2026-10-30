# Photobox for Android

A native, files-first backup client. Android 10 (API 29) or newer. Kotlin,
Jetpack Compose, Room, WorkManager and OkHttp; no Google Play Services or telemetry.
The host and Android client live in this repository while the protocol evolves.

## Build

Use JDK 17 and an Android SDK containing platform 36 and build-tools 36.0.0.
Set `ANDROID_HOME`, or create an untracked `local.properties` with `sdk.dir=...`.
Install host dependencies with `npm install` from the repository root before running
the interoperability tests.

From `android/`:

```sh
./gradlew :app:assembleDebug :api:test :app:testDebugUnitTest :app:lintDebug
```

The debug APK is `app/build/outputs/apk/debug/app-debug.apk`. With a test phone
connected and USB debugging enabled:

```sh
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

The wrapper pins Gradle 8.13 and verifies its distribution SHA-256. Dependencies
are pinned in the Gradle files. The debug APK is for development; release signing
and F-Droid packaging are follow-up distribution work.

## Connect and back up

1. Start the host with an existing export destination:
   `npm start -- --listen 0.0.0.0 --backup-dir ~/Photos`.
2. On the computer, choose **Connect a phone → Photobox for Android**. Choose the
   LAN/VPN address reachable from the phone.
3. In the Android app, tap **Scan host QR** (or paste the Android pairing data),
   name the phone, then **Connect**.
4. Grant photo/video access and photo-location access. The latter is needed for
   unredacted original bytes, including EXIF GPS. Selected-photo access is supported
   as a limited backup scope; full access is needed to discover all camera items.
5. Camera folder (`DCIM/Camera/`) is selected initially. Other discovered folders
   can be selected individually. Tap **Back up now**. The unmetered-network,
   battery-not-low and optional charging constraints still apply.

The host indexes uploads even if no export destination is configured, but they
remain **awaiting verified export**. Without a completed host export, the app does
not mark the item export verified. Originals are never deleted or modified by this
Android client.

**Open host in browser** opens the existing web UI. Browser pairing/cookies are
separate from the Android backup token; use the browser pairing flow if that
browser has not been connected yet. Native browsing is a later milestone.

## Trust and credentials

The native QR is versioned JSON (`type: photobox-pair`, `version: 1`) containing:

- The HTTPS host address, one-time code and expiry.
- Public trust certificate DER (base64) and its full SHA-256.
- Trust kind: `ca` for Photobox's own CA, or `certificate` for a user-supplied
  server certificate.

The client validates the certificate/fingerprint and expiry before exchanging the
code. TLS uses only that trust anchor, normal hostname verification and no HTTP
redirects. There is no trust-all fallback or certificate download over an
unverified connection. CA-backed leaf renewal works without re-pairing; a pinned
user-supplied leaf must be paired again when that certificate changes. The host
private key is never part of a QR or response.

The saved address must remain reachable. If it changes, pair again using a current
LAN/VPN address; a stable VPN address is useful when switching networks.

Device tokens and trust settings are persisted as AES-GCM ciphertext with a key
held by Android Keystore. Android backup of the app's data is disabled. Forgetting
a host clears local credentials and stops scheduled work; revoke the device on
the computer to invalidate the host-side token too.

## Backup engine

- MediaStore discovery covers accessible external volumes, images and videos.
  Pending/trashed/zero-byte items are excluded; folder selection is explicit.
- An observer schedules reconciliation while the process exists. A WorkManager
  periodic job also reconciles, including after process death/reboot. Android
  decides background execution timing; this is not an exact-time scheduler.
- Room stores each discovered version, its full hash, resumable URL/offset,
  receipt flags, errors and verification time. MediaStore generation/size/date
  changes create new versions without inheriting old proof.
- Originals are opened with `MediaStore.setRequireOriginal()`. Android 12+ reads
  also request original media format; the manifest declares supported original
  video formats to opt out of compatible-media transcoding.
- SHA-256 is streamed over the original, with metadata checked before/after.
  Chunks are bounded to 2 MiB. Upload URLs are persisted before PATCH; HEAD offsets
  reconcile lost acknowledgements after interruption. URLs must remain on the
  paired origin and within `/api/uploads/<id>` before a bearer is attached.
- A complete transfer is reconciled with `/api/assets/check`. A complete tus
  offset without valid reception proof starts a new repair session. Host proof
  must confirm received, indexed **and** exported before a version is marked
  export verified.
- Connection IDs and conditional Room updates prevent a stale worker from
  restoring old receipts after re-pairing. Queue mutations are serialized per
  process; upload state survives process death.
- Runs use a bounded nine-minute WorkManager window; large files resume across
  runs. When the app is visible, work can promote to a `dataSync` foreground worker
  with a cancellable notification. Background reconciliation does not request a
  foreground-service start, which Android 17 can deny. A visibility/quota race
  falls back to bounded work; cancellation and unrelated setup failures still stop
  the worker. Android may stop/defer jobs under execution quotas, including Android
  15+ foreground-service time limits when foreground promotion is in use.
- Pending work rotates by last attempt so originals awaiting host export do not
  block new uploads or starve other receipt checks. Abandoned/rejected partial
  sessions are cancelled best-effort; host-side immutable originals are retained.
- Pausing persists the setting and cancels pending/running work. A transfer already
  in flight may reach the host; the next run reconciles its actual offset.

`Export verified` is timestamped evidence for that content version, not a deletion
permission. This release has **no free-up-space flow**. That later flow must obtain
fresh host proof and re-hash the current local bytes/version immediately before
Android's system-confirmed trash/delete operation.

## Modules and checks

- `api/`: pure Kotlin protocol/TLS/tus client. JVM tests cover pinning, hostname
  rejection, redirect/origin isolation, offset validation, response identity and
  cancellation. A test starts `scripts/android-test-host.js` and exercises secure
  pairing, resumption and verified export against the real Node host, using only
  temporary synthetic files.
- `app/`: Compose UI, Android Keystore storage, MediaStore discovery, Room queue,
  WorkManager constraints and foreground notifications. Robolectric tests exercise
  actual Room persistence/version transitions and stale-worker rejection.
- Host regressions: `npm test` at the repository root.

## Device acceptance still required

Automated builds/JVM tests do not establish Android/OEM background behavior. Before
calling milestone 3 complete, run the matrix in [android-verification.md](../docs/android-verification.md)
on a real phone, including a mixed 10 GB initial backup, intact GPS/motion/HDR/RAW
bytes, airplane mode, reboot, process termination, permission changes and Android
execution limits. Signing/reproducibility and release distribution also remain open.
