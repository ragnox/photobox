# Android device verification

Milestone 3 acceptance is separate from compilation and JVM/Room tests. Record
device model, Android version, APK revision, host version and exact outcomes here
when physical-device testing is performed. A Pixel 10 Pro smoke run is recorded
below. Partial results do not count as passing the larger interruption/format matrix.

Use a synthetic/test media set first. Keep the host and phone originals; the
client has no cleanup/delete implementation.

| Scenario | Expected outcome | Status |
| --- | --- | --- |
| Install and cold launch | APK installs, main activity starts without a crash | Passed on Pixel 10 Pro / Android 17 |
| Scan Android QR over Wi-Fi | TLS validated before code exchange, paired name visible on host | Partial: existing native pair retained; LAN HTTPS and persisted credentials exercised; camera scan not rerun |
| Wrong CA/fingerprint, wrong hostname, expired code | No successful pairing or credential disclosure | Pending on device; JVM coverage exists |
| User-supplied leaf certificate | Pairing works; certificate rotation requires new QR | Pending on device; JVM coverage exists |
| Full photo/video/location permissions | All selected local originals discovered, original GPS retained | Partial: synthetic JPEG discovered/read with exact bytes and GPS; video-format cases remain pending |
| Android 14+ selected-photo access | UI reports limited scope; only authorized items enumerated | Pending |
| Permission revoked during hash/upload | Item stays unverified, clear error; granting permission allows retry | Pending |
| Charging/unmetered/battery constraints | Job waits for configured conditions; Pause prevents new chunks/work | Pending |
| Mixed 10 GB first backup | Every exported item has phone/host full SHA-256 equality | Pending |
| Pixel motion JPEG, Ultra HDR JPEG, HEIC, DNG, HEVC/HDR video | Byte-identical originals, no metadata stripping/transcoding | JPEG EXIF/GPS and appended opaque payload passed; specific motion/HDR/RAW/video formats pending |
| Airplane mode mid-video | Same upload resumes from server HEAD offset without restarting at zero | Pending |
| Process killed/rebooted mid-upload | Persisted Room URL/hash survives; WorkManager resumes when allowed | Partial: completed transfer, pairing and verified receipt survive force-stop/relaunch; mid-upload kill and reboot pending |
| Host restart/lost final HTTP response | Receipt/HEAD reconciliation prevents false failure or duplicate transfer | Partial: graceful host restart retained trust/pairing and completed-file proof; interrupted upload/lost-response case pending |
| Host disk full, missing export drive | Phone never shows export verified until valid copy exists | Partial: no destination produced no export proof; enabling destination produced verified proof; disk-full/unmount tests pending |
| Photo edited/renamed during transfer | Changed version is discovered; old proof is not inherited | Pending |
| Device revoked/re-paired during transfer | Old worker cannot reinstate old-session proof; new pair rechecks/reuploads | Pending |
| Android 15+ daily dataSync limit / Android 16 job quota | Interrupted work remains resumable; no false verification | Pending |
| Android 17 background foreground-service restriction | Foreground-start denial cannot block bounded reconciliation | Failure observed and fixed; physical transfer/receipt smoke passes, with four policy regression tests |
| VPN / network change | Reachable pinned address works; wrong address/certificate fails closed | LAN Wi-Fi passed; VPN/network transition pending |

## Pixel 10 Pro smoke run — 2026-10-26

- **Device:** Pixel 10 Pro, Android 17 / API 37. Debug APK `0.1.0` / version code 1,
  built from the working tree. APK SHA-256:
  `4220e6b0a917bdb00811f858f7ed8af5d6d076d3f75fb23b9e00bb6efb024cdf`.
- **Install/launch:** `adb install -r` succeeded; cold launch returned `Status: ok`.
  The existing native host pairing was preserved throughout package updates and
  force-stop/relaunch cycles.
- **Fixture:** one synthetic JPEG, `PHOTOBOX_DEVICE_TEST_e6639913.jpg`, in
  `Pictures/Photobox Device Test/`. It contains EXIF capture time/offset, synthetic
  GPS 35°N / 139°E, and an 8 MiB opaque trailer. Total size **8,389,437 bytes**.
  This exercises exact-byte preservation, not decoding of a real motion/HDR clip.
- **Full-byte proof:** original Mac fixture, phone file, host inbox original and
  plain-files export all matched SHA-256:
  `3ea10a29a4c13e86ea4db3364f7ae770f640208b5dce7c53aceb79bd3c44577e`.
- **Metadata:** host retained GPS 35 / 139 and local capture time
  `2026-10-26 08:03:43`, with `date_source: exif`.
- **Destination:** the user chose `~/Photos`; the host was gracefully restarted
  with the same library/TLS identity and `--backup-dir ~/Photos`. The test export
  is `~/Photos/2026/10/PHOTOBOX_DEVICE_TEST_e6639913.jpg`. At the end of the run,
  the host reported **197 received, 197 indexed, 197 export verified, zero failures**.
  Only the synthetic file was independently compared against its original bytes
  in this controlled run; the aggregate is not a full-corpus device acceptance test.
- **Phone receipt:** persisted Room row showed `state: VERIFIED`, full upload
  offset, matching SHA-256, `received=1`, `indexed=1`, `exported=1`, a verification
  timestamp and no per-file/global error. There was one host upload of the fixture;
  the force-stop/restart and receipt recheck did not reupload it.
- **Issue/fix:** Android 17 reported `startForegroundService() not allowed` when
  background reconciliation attempted unconditional foreground promotion. Workers
  now use their bounded WorkManager window without promotion in the background;
  visible work can promote, with a specific foreground-start-denial fallback.
  Cancellation/unrelated setup errors remain fatal to that run. The updated APK
  completed the physical smoke test after this change.
- **Checks:** debug assembly, nine Android/Robolectric tests (five queue tests plus
  four foreground-policy regressions), and Android lint completed successfully.
  Existing ten Kotlin transport tests include a real Node-host interoperability run.
- **Restoration:** the controlled transfer used only the dedicated fixture folder.
  The phone's original selected-folder list and unpaused state were then restored;
  the host remains configured for automatic export. No phone originals were deleted.

## Record

- Device / Android:
- APK / source revision:
- Host / filesystem / network:
- Dates and observed execution delays:
- Input files, bytes, and distinct full SHA-256 counts:
- Confirmed host export files and SHA-256 counts:
- Failures, logs without device tokens, and follow-up fixes:

Do not mark the Android milestone complete solely because `assembleDebug`, unit
tests or a small emulator smoke test passes.
