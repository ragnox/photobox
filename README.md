# Photobox

Your Google Photos library, on your own disk. Point Photobox at an extracted
Google Takeout (or any folder of photos) and you get a fast timeline with
albums, favorites, live photos and videos. It reads your files and never changes them,
and it keeps watching the folders for new photos.

## Run it

**As a desktop app (macOS):**

```
npm install
npm run dist:mac     # builds dist/Photobox-0.1.0-arm64.dmg and dist/mac-arm64/Photobox.app
```

Drag `Photobox.app` to Applications. A build you made yourself opens normally. The build
isn't signed, so on another Mac macOS will block it the first time: open it once, then go to
System Settings → Privacy & Security and click **Open Anyway**. During development,
`npm run desktop` runs the app straight from source.

**In the browser:**

```
npm start -- ~/Downloads/Takeout ~/Pictures/Camera --open
```

Then open http://localhost:4567 and add folders with **Add folder**.

## Getting your photos out of Google

1. Go to takeout.google.com, click **Deselect all**, then select **Google Photos**.
2. Export as `.zip`. Choose 50 GB parts so you get fewer files, and download every part.
3. Extract all the parts. One folder or one folder per part both work.
4. Add that folder to Photobox.

## What it handles

Takeout spreads each photo's real metadata (date, GPS, description, favorite,
people) over JSON "sidecar" files whose names often don't match the photo's name.
`src/takeout/sidecar.js` matches them up:

| On disk | Sidecar |
| --- | --- |
| `IMG_1.jpg` | `IMG_1.jpg.json`, `IMG_1.jpg.supplemental-metadata.json` |
| `IMG_1(1).jpg` | `IMG_1.jpg(1).json`, `IMG_1.jpg.supplemental-metadata(1).json` |
| `IMG_1-edited.jpg`, `-bearbeitet`, `-modifié`, … | the original's sidecar |
| long names | cut at ~51 chars: `…Long Appl.json`, `….jpg.supp.json`, `….jpg.s.json` |
| `IMG_1.MP4` (live photo) | `IMG_1.HEIC.json` |
| `PXL_1.MP` (Pixel motion photo clip) | `PXL_1.MP.jpg.supplemental-metadata.json` |
| renamed/sanitized files | matched through the `title` field |
| sidecar in another zip part | matched by path below `Takeout/` |
| `Café.jpg` NFD vs NFC | Unicode-normalized |

It also handles these:

- **Duplicates.** A photo that appears in "Photos from 2019" and in an album is shown once. Full SHA-256 identifies content; the size/prefix/suffix fingerprint is a candidate/cache hint. Older libraries gain full identities during background scans without replacing existing cache keys.
- **Versions of one shot.** The same photo with different bytes (recompressed by Google's "Storage saver", in a second Google account, or Google's smaller album copy) is shown once, as its best version: a phone backup's original, else the biggest file. A version needs the same capture time to the sub-second and camera from EXIF (videos: creation time and length), the same shape, and a thumbnail that looks the same. Pixel renderings of one capture (`.PORTRAIT-01.COVER`, `.ACTION_PAN-02.ORIGINAL`) and edited copies (`-edited`, `~2`) stay separate photos. The info panel lists the other versions, with **Not the same photo** to show both again.
- **Albums.** Folders with an album `metadata.json` become albums, also when it holds only a title (newer exports) or is named in the export's language. An album without a title is named after its folder. Year folders aren't albums. Albums belong to the folder they were read from, so two Google accounts can each have a "Trip".
- **Several Google accounts.** Extract each account's Takeout into its own folder and add each with a name ("Google, second account"); the pencil next to a folder renames it. Click a folder to see only the photos from it; the info panel says where each photo came from.
- **Dates.** EXIF with a time zone comes first, then the Takeout timestamp, then EXIF without a zone, then a date in the file name, then the upload date, then the file's modified time. A UTC time is shown in the time zone of the photo's GPS location, so a Tokyo photo shows Tokyo time.
- **Live photos.** A short clip next to a still with the same name becomes that photo's motion: `IMG_1.HEIC` + `IMG_1.MOV`, and Pixel motion photos, which Takeout splits into `PXL_1.MP.jpg` + `PXL_1.MP`. It's hidden from the grid and plays when you press **LIVE** or `L`.
- **Trashed items** in the export are skipped.
- **HEIC and RAW.** On macOS these are decoded with `sips`. Videos get thumbnails and metadata from `ffmpeg`/`ffprobe`.
- **Watching.** New, changed and deleted files in any source folder show up in the open app within a few seconds.

## Commands

```
photobox init <folder>              # make <folder> an archive, e.g. ~/Pictures (see below)
photobox serve [folders...] [--port 4567] [--open] [--data ~/.photobox] [--archive <folder>]
                [--listen <address>] [--remote-port <n>] [--tls-cert <file> --tls-key <file>]
                [--backup-dir <existing-folder>]
photobox scan [folders...]          # index once (all known folders if none are given), then exit
photobox export <dest> [folders...] [--dry-run]   # copy everything into <dest>/YYYY/MM/
photobox export [--dry-run]         # inside an archive: copy everything into the archive
photobox sort [--dry-run] [--keep <folder>]   # inside an archive: move what's there into YYYY/MM/
photobox sort --undo                # put back what the last sort moved
photobox merge <folder> [--dry-run] # inside an archive: bring in an export folder
photobox merge --undo               # take out what the last merge brought in
photobox adopt                      # inside an archive: take over the library in ~/.photobox
npm test                            # all tests; the fake-Takeout import runs on macOS with ffmpeg
npm run test:ui                     # the web UI end to end, in a hidden Electron window
npm run fake-takeout -- fixtures/demo   # build a demo export that hits every edge case
```

The library database and thumbnail cache live in `~/.photobox`. You can change this with
`--data` or `PHOTOBOX_DATA`. Imported source folders are read-only. Native backup uploads
also store **originals** in this data folder's `inbox/`; keep those originals before
deleting the data folder to reset Photobox.

## Exporting to a folder you own

```
photobox export ~/Photos ~/Downloads/Takeout
```

This copies every photo and video into `~/Photos/YYYY/MM/`, by the date it was taken in the
place it was taken. After that the folder is all you need: no Takeout, no Photobox, no database.

- **Once each.** A photo that appears in a year folder and in an album is copied once, under its
  real name (from the sidecar when Takeout cut the name short). Two different photos with the same
  name in one month become `IMG_0001.JPG` and `IMG_0001 (2).JPG`.
- **Dated.** Each copy's modified time is set to when the photo was taken.
- **Live photos stay paired.** The clip gets its still's name: `IMG_1234.HEIC` and `IMG_1234.MOV`.
- **Nothing is overwritten.** Sources are only read. If a different file already has a target
  name, it stays and the photo gets the next free name. Copies are written to a hidden `.partial`
  file first, so an interrupted export never leaves half a photo.
- **Run it again** to copy only what's new. A file you delete from the export is copied again
  next time. To drop a photo for good, delete it from the source.
- **Better versions replace older ones.** When a better version of an exported photo turns up
  (from a second account, say), it is copied under a new name (`PXL_1 (2).jpg`), and once it is
  verified the older file moves to `.photobox/superseded/` in the export, never deleted. The
  manifest's `superseded` section says which file replaced it.
- **Reorganize freely.** Move or rename files inside the export, or sort them into folders of
  your own. The next export finds them by content instead of copying them again. Originals in a
  Photobox source folder inside the export (a Takeout unpacked there, say) don't count.
- **`photobox-export.json`** records each file's albums, favorite flag, description, people,
  place and exact time, and what has been exported (if it gets lost, files already in place are
  recognized by content). Add the folder, or a copy of it on another machine, to Photobox and
  all of that comes back, also for files you've moved or renamed. A photo in several albums is
  one file there and is listed in all of them.

`--dry-run` lists what would be copied, and which older versions would move aside. Folders
given to `export` are added and scanned first. Without folders it rescans the library's folders,
or, if Photobox is running, exports that running library as it is.

Only one Photobox writes to a folder at a time: an export, sort or merge holds a hidden
`.photobox-writing` file in it while it works, and one in another process (the app exporting a
phone backup while a nightly export runs, say) waits until it's done. A lock left by a process
that's gone is taken over.

## Archives: the folder your photos live in

```
photobox init ~/Pictures
cd ~/Pictures
photobox scan ~/Takeout/2026-01-10    # the folders your photos come from
photobox export                       # copies them into ~/Pictures/YYYY/MM/
```

`photobox init` makes a folder an archive. Like a git repository's `.git`, the archive gets a
hidden `.photobox` folder for its own Photobox data. So far that is just a random id, which
copies of the archive keep.

Inside an archive, or with `--archive <folder>`, Photobox uses a library of that archive's
own, a cache in `~/.photobox/cache/<archive id>`. `export` without a destination copies into
the archive. The archive itself, or a folder holding it, can't be one of its sources.
Everywhere else Photobox uses the library in `~/.photobox`, as before.

The archive's own photos, the files its `photobox-export.json` lists, are always in its
library, under the archive's folder name. The app shows them next to the sources' photos, each
photo once, and calls the archive's file the copy in your library folder. An album the archive
and a source both have is listed once, as the archive's; picking a source lists its own albums.
`photobox serve` in an archive also makes the desktop app open that archive from then on.

### Sorting what's already there

```
photobox sort --dry-run     # what would move where
photobox sort               # move it
photobox sort --undo        # put back everything the last sort moved
```

A folder that becomes an archive often holds years of photos already: loose files, trip
folders, camera dumps. `photobox sort` moves them into the archive's `YYYY/MM/` folders, by
when they were taken. Files are moved, never copied, so it needs no extra space.

- **Folder names become albums.** `BVI 2017/GoPro/GOPR1.jpg` goes to `2017/03/GOPR1.jpg`, in
  the album "BVI 2017 / GoPro". Names that only say how files got there make no album, such as
  `DCIM`, `100CANON` and "Photos from 2019".
- **Dated like the library:** by the camera's EXIF date, a Google Takeout sidecar, a date in the
  file name, or else the file's date. The preview counts how many are dated each way.
- **Exact duplicates move to `.photobox/superseded/`,** under their old paths. The copy that
  stays gets every copy's albums.
- **Nothing is overwritten or deleted.** Two different `IMG_1.jpg` from one month become
  `IMG_1.jpg` and `IMG_1 (2).jpg`, and a live photo's clip keeps its still's name. Files that
  aren't photos or videos stay in their folders. A folder left empty is removed.
- **Every move is recorded** in `.photobox/history.jsonl` before the old name goes, so
  `--undo` can put each file back. A file that changed since it was sorted stays where it is
  and is listed.
- **Left in place:** sync folders (Syncthing's `.stfolder`), app libraries, the year folders,
  the archive's sources, and any folder you name with `--keep <folder>`. Kept folders are
  remembered in `.photobox/settings.json`.
- **The manifest** gets an entry for every sorted file, with its albums and where it was. A later
  `photobox export` into the archive finds those files by content and doesn't copy them again.

### Merging an export folder

```
photobox merge ~/Photos --dry-run   # what would come in, and what is here already
photobox merge ~/Photos             # bring it in
photobox merge --undo               # take out what the last merge brought in
```

A library exported with `photobox export` before the archive existed comes into the archive
with `photobox merge`. The folder is only read; it can be deleted once you no longer need it.

- **Each photo once.** Photos the archive has already, by content, stay where they are and get
  the folder's albums, people and favorites. The others come in under the same `YYYY/MM/` path,
  or the next free name, and a live photo's clip keeps its still's name.
- **No extra space on the same disk.** Files come in as hard links: the same file under a second
  name, so the folder keeps its own. From another disk they are copied and verified, and only if
  the disk has room to spare.
- **Better versions win.** Where the folder replaced a photo by a better version (its manifest's
  `superseded` section) and the archive has the older one, the older one moves to
  `.photobox/superseded/` once the better one is in, and passes on its albums. The folder's own
  older versions stay out.
- **Checked first.** A file that no longer matches the folder's manifest, or an empty one, stays
  out and is listed.
- **Every change is recorded** in `.photobox/history.jsonl`, also for photos that were here
  already, so `--undo` takes out what came in and puts back what moved aside. Changes are undone
  newest first: after a sort and then a merge, the merge is undone before the sort. A file whose
  original in the folder is gone stays.

### Taking over the library you had

```
cd ~/Pictures
photobox adopt    # the library in ~/.photobox becomes this archive's
photobox scan     # adds the archive's own photos
photobox serve    # the app shows the archive
```

A library from before archives becomes an archive's library with `photobox adopt`: its sources
and their names, favorites, versions, paired phones and thumbnails come along, so nothing is
indexed or paired again. The library in `~/.photobox` stays as it was. An archive whose library
has sources or paired phones of its own already is left alone.

Apple Photos, iPhoto and Aperture libraries and app bundles in a folder are always skipped.
What else an archive will hold, such as its named sources and its history, is described in
[docs/archives.md](docs/archives.md).

## Your library on your phone

```
photobox serve --listen 0.0.0.0
```

This also serves Photobox to phones on your Wi-Fi or VPN, over HTTPS on port 4568. Instead of
`0.0.0.0` (every network this computer is on) you can give one address, such as a WireGuard
address. Nothing is reachable from the internet unless you forward a port yourself.

1. On the computer, open Photobox and choose **Connect a phone** in the sidebar. It shows a QR
   code with a one-time pairing code.
2. Scan it with the phone's camera. The first time, the browser warns that the connection is not
   private, because Photobox uses its own certificate. Tap **Advanced**, then **Proceed**.
3. Name the phone and tap **Connect**. The phone can now see your library.
4. To install Photobox as an app, install its certificate on the phone once (the pairing page
   walks you through it), then choose **Install app** in the browser menu.

A paired phone can browse the timeline and albums, view photos and videos, and set favorites.
Adding or removing folders, rescanning and pairing stay on the computer. The sidebar's
**Devices** section lists paired devices and when each was last seen; disconnecting one locks
it out immediately.

### Phone backup development

The host supports paired, resumable uploads, full SHA-256 identities, timeline
indexing and verified automatic export. To export phone uploads into an existing folder:

```
npm start -- --listen 0.0.0.0 --backup-dir ~/Photos
```

`PHOTOBOX_BACKUP_DIR` also sets the destination. Received originals stay in
`~/.photobox/inbox/` and appear in the timeline; verified copies go to `~/Photos/YYYY/MM/`
by local capture date. A destination marker prevents an unavailable drive from being
silently replaced by an empty mount point. The sidebar shows indexing/export progress
and failures; interrupted work retries after restart.

The [Android client](android/README.md) now implements native QR pairing, camera/folder
backup, persistent resumable transfers, and host receipt tracking. Build its debug
APK from `android/`, install it on Android 10+, then select **Photobox for Android**
in the computer's pairing dialog. Device/OEM background acceptance is still pending;
see the [verification matrix](docs/android-verification.md).
See the [implementation plan](docs/phone-backup-plan.md) and
[native backup API](docs/backup-api.md). Reception alone does not make an item eligible
for removal from the phone.

## Desktop app

`desktop/main.js` runs the library server in an Electron utility process, so imports
never freeze the window, and shows the same web UI in a native window. On top of
the browser version it adds:

- ⌘O, and adding folders by dragging them onto the window
- native right-click menus: a photo's (below), and Cut, Copy, Paste in text fields
- Dock progress while importing
- links that open in your normal browser
- a window size and position that are remembered between launches
- folder watching that keeps running after you close the window, until you quit with ⌘Q

The app opens the library `photobox serve` last ran on: an archive's, or the one in
`~/.photobox` if it last ran outside any archive. Only one of
them indexes it at a time: whichever starts first owns it, and the other just shows
that server (the CLI prints its URL, and the app opens it in its window).

Videos need ffmpeg (`brew install ffmpeg`). The app finds Homebrew's ffmpeg even when
it's opened from Finder.

## Keyboard (viewer)

`←` `→` browse · `I` info · `F` favorite · `L` play live photo · `⌘C` copy the photo · `Esc` close

Right-clicking a photo, in the timeline or the viewer, offers **Copy Photo** (full size, to paste
into a mail or a chat), **Show in Finder** (on the computer running Photobox) and **Get Info**.

## Layout

```
bin/photobox.js          CLI: serve / scan / export
src/app.js               starts library + indexer + watcher + server; single-instance lock
src/config.js            data folder, port, paths of the database and caches
desktop/main.js          Electron shell: window, menu, native dialogs, Dock progress
desktop/server-process.js  library server inside an Electron utility process
desktop/preload.cjs      the small native API the UI may use (window.photobox)
src/takeout/sidecar.js   Takeout sidecar matching (pure, unit-tested)
src/indexer.js           walk → match sidecars → hash/dedupe → metadata → thumbnail → SQLite
src/metadata.js          EXIF (exifr) and video metadata (ffprobe)
src/dates.js             timestamp parsing, filename dates, GPS → time zone
src/thumbs.js            thumbnails/previews (sharp, sips and ffmpeg fallbacks)
src/media.js             which file types are photos and videos
src/files.js             folder walking, the content fingerprint, path helpers
src/db.js                SQLite schema + queries (node:sqlite, no native build)
src/export.js            copy the library into <dest>/YYYY/MM/ + photobox-export.json
src/manifest.js          reading photobox-export.json, for the export and the indexer
src/watcher.js           chokidar → debounced rescans of the affected folders
src/server.js            HTTP API: the localhost listener and the one for paired devices
src/remote.js            pairing codes and device tokens
src/uploads.js           native resumable uploads and full-SHA-256 reception receipts
src/backup.js            managed inbox indexing, automatic verified export, retries/proof
src/tls.js               Photobox's own CA and server certificate for --listen
public/                  the app: justified timeline, year scrubber, albums, viewer
public/pair.html, pair.js  the page a phone opens from the QR code
public/sw.js             service worker: installable app, cached thumbnails
```

## Security

The local server binds to `127.0.0.1`. It rejects requests whose `Host` isn't localhost,
which blocks DNS rebinding, and accepts only JSON writes. The HTTPS listener also
accepts native binary uploads on dedicated routes that require a bearer token;
browser cookies cannot authorize those uploads.

With `--listen`, a second listener serves other devices, over HTTPS only. Every request needs a
paired device's token, except the pairing page and the CA download. Tokens are 256-bit random
values sent as a cookie (HttpOnly, Secure, SameSite=Strict) or a bearer header. The database
stores only their SHA-256. Pairing codes work once and expire after 10 minutes. Errors are
answered with a short JSON message, never a stack trace.

The certificate authority lives in `~/.photobox/tls`. Photobox renews the server certificate
when your addresses change, and a phone that trusts the CA keeps trusting it. To use a
certificate browsers already trust instead, such as one from `tailscale cert`, pass `--tls-cert`
and `--tls-key`.

## Not yet

- Code signing and notarization, auto-updates, and a Windows or Linux build. The config is there, but it hasn't been tried.
- Search, map view, face grouping, place names (reverse geocoding).
- Reading `.zip` parts directly (extract them first).
- Transcoding for videos the browser can't play (`.avi`, `.mts`, …). Those show a thumbnail and **Show in Finder**.
- Writing metadata back into files. Favorites you set in Photobox live in its database.
- Physical-device acceptance and release packaging for Android, and user-confirmed phone cleanup.
  The [phone backup plan](docs/phone-backup-plan.md) tracks the next milestones.
- `--listen` in the desktop app. For now, start network access with `photobox serve --listen`.
- Choosing an archive in the desktop app (it opens the one `photobox serve` last ran in), and an
  archive's sources, history and manifest in its `.photobox` folder ([docs/archives.md](docs/archives.md)). For now, the manifest of an export into an
  archive is still `photobox-export.json` at its top.
