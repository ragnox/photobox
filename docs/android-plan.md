# Photobox for Android: an open-source way off Google Photos

A plan for replacing Google Photos on Android phones with something you own: the
photos live as plain files on your own disk, the phone backs up to that disk and
browses it, and no part of it needs a Google account or anyone's cloud.

It builds on what Photobox already does on the desktop and on what we learned
moving a real library (an Android phone plus a Google Takeout) off Google.

## Principles

1. **Files first.** Originals are stored byte for byte in `YYYY/MM/` folders.
   Albums, favorites, people, descriptions and dates live next to them in open
   formats (`photobox-export.json` today, XMP sidecars next). Any app, including
   this one, can be thrown away without losing anything.
2. **No account, no cloud by default.** The phone talks to a machine you own, on
   your Wi-Fi or over your own VPN.
3. **Verified before delete.** The phone frees space only after the library host
   has proved it holds an identical copy (full SHA-256). Nothing is ever deleted
   automatically, and nothing is deleted on the host because it was deleted on
   the phone.
4. **Boring parts.** One process, SQLite, plain HTTP over a private network.
   It should run on a Mac in the corner or a small NAS without a Docker stack.
5. **Leaving is tested.** Every release must pass an export and re-import round
   trip with nothing lost (Photobox's test suite already does this for the desktop).

## What we learned

### How Google keeps you in

- **No API to your own library.** Since 31 March 2025 the Google Photos Library
  API only returns items the calling app uploaded itself. A third-party app can't
  list or download your library; the Picker API only hands over what you tap.
- **Takeout is the only way out in bulk, and it's manual.** You request an export
  in a browser and wait (it can be ready the same day), the links expire after
  7 days, and every download needs a browser signed in to Google. Google asked
  for the password again before the first part would download. There is no
  supported way to script it without handing a tool your Google session.
- **The export is split and mixed.** An export comes as several parts: zips with
  photos, zips with other products (Drive, Mail, ...), and sometimes a large video
  delivered as a loose file next to the zips. Browsers may start several parallel
  part downloads only slowly or not at all, so each part may have to be clicked.
- **The metadata is scattered.** The real date, place, description, favorite flag
  and people sit in JSON sidecars whose names often don't match the photo:
  `.supplemental-metadata.json`, counters moved behind the extension
  (`IMG_1.jpg(1).json`), names cut at about 51 characters, localized `-edited`
  suffixes, live-photo videos using the still's sidecar, NFD/NFC differences.
  Without the sidecars most photos fall back to the export date.
  `src/takeout/sidecar.js` handles all of these and is unit-tested.
- **Albums are copies.** A photo in an album appears once in its year folder and
  again in every album folder; naive importers duplicate it.
- **Not everything is exported.** The Locked Folder is left out. Trashed items
  are included and must be skipped.
- **Deleting is coupled to the phone.** With backup on, deleting a photo in
  Google Photos also deletes it from the phone. "Clear Google Photos" therefore
  has to start with turning backup off.
- **The default gallery is the lock-in.** On a Pixel, Google Photos is both the
  gallery and the backup, so leaving Google Photos also means replacing the app
  you look at photos with.

### What already works without Google

- **Phone to computer:** Syncthing copies the Pixel's camera folder to the Mac
  over Wi-Fi. The official Syncthing Android app was retired at the end of 2024;
  the community fork (Syncthing-Fork, on F-Droid and GitHub) continues it. Set up
  safely, the computer side is **receive only**, **ignores deletions from the
  phone** (so you can free space on the phone) and keeps **a year of old
  versions**. Out of the box it was send-and-receive with no versions, so a
  deletion on either side was mirrored immediately.
- **Library:** `photobox export ~/Photos <sources>` turns the phone folder and the
  Takeout into one deduplicated `YYYY/MM` library, with `photobox-export.json` holding albums,
  favorites, people, places and dates. Adding the folder back to Photobox
  restores all of it, also after files were moved or renamed.
- **Viewing:** the Photobox web app shows the timeline, albums and viewer at
  `http://localhost:4567`. It is localhost-only today.

What's missing is the phone side: browsing the library from the phone, a backup
that confirms each photo arrived intact, and a safe "free up space".

## Existing open-source options

| Project | What it is | Fit |
| --- | --- | --- |
| [Immich](https://immich.app) | Server plus Android/iOS apps: backup, timeline, faces, search, sharing | The most complete replacement today. Needs Docker, Postgres and a machine-learning container running all the time. Phone uploads go into Immich-managed storage, and albums and favorites live in its database. It can index existing folders read-only ("external libraries"), but can't back up into them. |
| [Ente](https://ente.io) | End-to-end encrypted photo cloud with open-source apps | Strong privacy, but it's a hosted service by default. The server is published and can be self-hosted, with more moving parts. Files are stored encrypted in its own format. |
| [PhotoPrism](https://www.photoprism.app) | Server that indexes your folders, with a web UI | Files-first like Photobox, but no native backup app; uploads go through the web or WebDAV. |
| Nextcloud + Memories | Photo timeline inside Nextcloud | Fine if you already run Nextcloud; a lot of platform for photos alone. |
| Syncthing-Fork (F-Droid, GitHub) | Android Syncthing client | Moves files reliably. It knows nothing about photos, so it can't say "safe to delete", and it doesn't browse. |
| [Fossify Gallery](https://github.com/FossifyOrg/Gallery), [Aves](https://github.com/deckerst/aves) | On-device galleries | Good replacements for the Google Photos app as the phone's gallery. Neither backs up. |

**If you want everything today:** run Immich and point it at `~/Photos` as a
read-only external library. You get faces and search without handing it
ownership of the files. New phone photos would still need to reach `~/Photos`
through Syncthing.

**What this plan adds instead:** the files-first model all the way to the phone.
The library stays plain folders that Photobox owns no more than any other app,
the host is a single small process, and the phone app's job is narrow: back up
with proof, browse, and free space safely.

## Architecture

```
 Pixel                                 Library host (Mac or NAS)                       Elsewhere
┌──────────────────────┐   Wi-Fi /     ┌──────────────────────────────────────┐
│ Photobox for Android │   WireGuard   │ photobox serve --listen              │
│  backup  ────────────┼──────────────▶│  /api/uploads (resumable, SHA-256)   │
│  browse  ◀───────────┼───────────────┤  /api/timeline, thumbs, originals    │
│  free up space       │  paired       │        │                             │
│                      │  device token │        ▼                             │
│ (or: Syncthing-Fork ─┼──────────────▶│ inbox/<device>/  ─┐                  │
│  camera folder)      │               │ Takeout/          ├─▶ photobox export│
└──────────────────────┘               │ other sources    ─┘        │         │
                                       │                            ▼         │      restic
                                       │      ~/Photos/YYYY/MM + sidecars ────┼───▶ (B2, Hetzner,
                                       └──────────────────────────────────────┘      a drive at family)
```

- **The inbox stays separate from the library.** Uploads land in a per-device
  inbox folder that Photobox indexes like any other source. The scheduled
  `photobox export` copies them into `~/Photos`. Syncthing and the app feed the
  same pipeline, so either can be used, or both.
- **Remote access goes over a private network,** not the open internet:
  WireGuard, or Headscale/Tailscale. Photobox never needs a public port.

## The work

### A. Library host (Photobox, Node)

1. **Listen beyond localhost, safely.** `photobox serve --listen <address>`,
   opt-in. Every API route requires a device token except on loopback.
   Rejecting non-localhost `Host` headers stays as it is for loopback.
2. **Device pairing.** The desktop shows a QR code with a one-time code and the
   server's certificate fingerprint. The phone exchanges it for a long-lived
   per-device token, stored hashed on the server. Devices are listed and
   revocable in the UI.
3. **Transport security.** WireGuard already encrypts. For plain Wi-Fi, a
   self-signed certificate created on first run, pinned by fingerprint during
   pairing. No public CA, no domain needed.
4. **Resumable uploads.** The [tus](https://tus.io) protocol (open standard,
   maintained Node server) at `/api/uploads`. Metadata: file name, size,
   capture time, the phone's MediaStore ID and the SHA-256 computed on the
   phone. The server writes to `inbox/<device>/YYYY/MM/` through a temporary
   file, computes SHA-256 itself, and only then moves the file in place.
5. **Proof of arrival.** `POST /api/assets/check` with a list of SHA-256 values
   returns for each one: received, indexed, and exported into the library. The
   phone frees space only for items that are all three. This needs a full
   SHA-256 per media item in the database next to today's quick fingerprint.
6. **Scheduled export** as a supported feature rather than a hand-written
   launchd job: `photobox schedule export ~/Photos --daily 03:30` writes and
   loads a launchd agent (macOS) or a systemd user timer (Linux).
7. **XMP sidecars.** Write `IMG_1234.jpg.xmp` next to each exported file with
   the date, place, description, rating/favorite, keywords for albums and
   people, so digiKam, darktable, Lightroom and Immich can read them too.
   `photobox-export.json` stays as the complete record.
8. **Installable web app (PWA).** A manifest and service worker, plus a
   touch-friendly viewer (swipe, pinch). Together with item 1 this gives a phone
   view of the library before any Android code exists.

### B. Android app (Kotlin, Jetpack Compose)

1. **Backup engine.**
   - Find new and changed items through MediaStore (images and videos), noticed
     by a `ContentObserver` and run by WorkManager.
   - Constraints are configurable: unmetered network only, battery not low,
     optionally only while charging.
   - Per-item state in a local Room database: MediaStore ID, size,
     `DATE_MODIFIED`, SHA-256, upload state, server confirmation.
   - Uploads in chunks over tus, resumed after network changes, reboots and app
     updates.
2. **Exact bytes, including location.** Android removes GPS from EXIF when an app
   reads a photo without `ACCESS_MEDIA_LOCATION` and
   `MediaStore.setRequireOriginal()`. The app must request both, or every backed-up
   photo loses its place.
3. **Permissions done right.**
   - `READ_MEDIA_IMAGES` and `READ_MEDIA_VIDEO` on Android 13 and later.
   - On Android 14 and later the user can grant access to selected photos only.
     The app must detect that and explain that a backup needs full access.
   - Long uploads run as a `dataSync` foreground service. Android 15 limits that
     type to about 6 hours per day, so big first backups must resume across days.
4. **Pixel formats untouched.** Motion photos (`PXL_….MP.jpg` with the video
   embedded after the JPEG), Ultra HDR JPEGs with gain maps, DNG RAW and large
   videos are uploaded exactly as they are. The host can extract the motion
   part for playback later.
5. **Free up space.**
   - The app lists items that are confirmed on the host (received, indexed and
     exported) and how much space they use.
   - It deletes through `MediaStore.createTrashRequest` / `createDeleteRequest`,
     so Android itself asks the user to confirm, and trashed items stay
     recoverable for 30 days.
   - Never automatic, never for unconfirmed items.
6. **Browse.**
   - Timeline, months and albums from the host's API.
   - Thumbnails cached on the phone so recently viewed parts work offline.
   - Full-size images and videos streamed from the host.
   - On-device photos not yet backed up are shown with a marker.
7. **Pairing.** Scan the QR code from the desktop. That stores the server
   address, certificate fingerprint and device token, and nothing else.
8. **Distribution.** GitHub releases and F-Droid, with reproducible builds and
   no Google Play Services. Play Store optional later.

### C. Leaving Google (a guided flow, desktop side)

1. **Ask for the export.** Show the Takeout link with Google Photos preselected
   and the settings to choose.
2. **Watch the downloads.** Check each part as it arrives (zip test), extract
   into one folder without overwriting, and keep loose large files. For the
   first migration this was a throwaway shell script; it becomes a Photobox
   command.
3. **Import.** Run `photobox export ~/Photos <Takeout>/Google Photos` and show a
   report: files seen, unique items, duplicates merged, trashed skipped, items
   without a sidecar, failures.
4. **A checklist before clearing Google.**
   - Turn off backup in the Google Photos app on the phone.
   - Move anything out of the Locked Folder.
   - Make sure a second copy of `~/Photos` exists (restic or an external drive).
   - Compare the counts.
   - Then select by date range in Google Photos and move to the trash. Google
     keeps it there for 60 days; emptying it stays a manual step.

## Phases

| Phase | Delivers | Done when |
| --- | --- | --- |
| **0. Today, no new code** | Syncthing-Fork on the phone with safe computer-side settings, Photobox library, daily export, off-site restic backup, Takeout imported, Google Photos backup turned off | A photo taken on the phone is in `~/Photos/YYYY/MM` the next morning, and Google holds no copy |
| **1. Library on the phone** | A1–A3, A8: authenticated LAN/VPN access and the installable web app | The paired phone scrolls the full timeline over Wi-Fi and WireGuard, and an unpaired device gets 401 on every route |
| **2. Backup with proof** | A4–A6, B1–B5, B7: the Android backup app and the scheduled export | A new photo reaches the host within minutes on Wi-Fi. A 10 GB first backup survives airplane mode, reboots and the daily limit. Host and phone SHA-256 match for every item, GPS included. "Free up space" offers only confirmed items |
| **3. Browse and organize natively** | B6, A7: native timeline and albums, favorites and albums edited from the phone, XMP sidecars | Favorites set on the phone show up in `photobox-export.json` and the XMP files, and survive an export/re-import round trip |
| **4. Smart features, privately** | Search by content and face grouping with open models running on the host, a map on OpenStreetMap, offline place names | Search for "beach" returns beach photos without any network call leaving your network |

Phase 0 is mostly in place on the first machine already. Phases 1 and 2 are the
core: after them, the phone no longer needs Google Photos for anything.

## Repository layout

Keep it one repository while the API is moving, so a server change and the app
change that depends on it land together:

```
photobox/
├── src/, public/, desktop/, bin/   library host, as today
├── android/                        Gradle project: app/, backup/, api/ modules
├── docs/                           this plan, the API reference, the leaving-Google guide
└── scripts/                        Takeout download checks, schedule helpers
```

Split `android/` into its own repository once the API is versioned (`/api/v1`).

## Security and privacy

- **No telemetry**, no crash reporting to third parties, no Google Play Services.
- **Device tokens** are revocable, stored hashed on the host and kept in the
  Android Keystore on the phone.
- **TLS** with the pinned self-signed certificate, or WireGuard. Both are fine;
  plain HTTP only on loopback.
- **Uploads can't escape the inbox.** The server picks the file name and path,
  and rejects path components from the client.
- **Deletions only flow phone-ward and only on request.** The host never deletes
  originals because the phone did.

## Risks and open questions

- **Background limits.** Doze and the `dataSync` time limit can stall large
  first backups. Mitigation: resumable uploads, a "back up now while charging"
  mode, and Syncthing as a fallback transport for the first big sync.
- **Edits on the phone.** Some editors overwrite the original in MediaStore.
  The app must treat a changed `DATE_MODIFIED` and hash as a new version and keep
  both on the host.
- **SD card and Android's "all files access".** Not needed if the app only uses
  MediaStore. Avoid it: it's what got Syncthing removed from the Play Store.
- **Licensing.** Photobox is MIT today. If the project accepts outside
  contributions to a hosted variant, consider AGPL for the server. Decide before
  publishing.
- **iPhone.** Out of scope. The host and the web app work from any browser, and
  PhotoSync-style uploaders could target the tus endpoint.

## Non-goals

- A hosted service, or anything that requires an account with us.
- Editing tools beyond rotate and crop; other apps do that better.
- Replacing the camera app, or the phone's on-device gallery for photos that
  aren't backed up yet.

## Sources

- [Syncthing Android app retired (Techlore discussion)](https://discuss.techlore.tech/t/the-syncthing-android-app-is-being-discontinued-but-alternatives-remain-available/10427)
- [Status of syncthing-fork in 2026 (BasicSync issue)](https://github.com/chenxiaolong/BasicSync/issues/1)
- [Immich external libraries are read-only, uploads go to Immich storage (ZimaSpace guide)](https://shop.zimaspace.com/blogs/support-tips/immich-external-libraries-read-only-sources)
- [Ente Photos on F-Droid](https://f-droid.org/packages/io.ente.photos.fdroid/)
- [Data Portability API scopes: no Google Photos scope](https://developers.google.com/data-portability/user-guide/scopes)
