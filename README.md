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
| renamed/sanitized files | matched through the `title` field |
| sidecar in another zip part | matched by path below `Takeout/` |
| `Café.jpg` NFD vs NFC | Unicode-normalized |

It also handles these:

- **Duplicates.** A photo that appears in "Photos from 2019" and in an album is shown once. Files are matched by content (size plus the first and last 64 KB).
- **Albums.** Folders with album `metadata.json` become albums. Year folders don't.
- **Dates.** EXIF with a time zone comes first, then the Takeout timestamp, then EXIF without a zone, then a date in the file name, then the upload date, then the file's modified time. A UTC time is shown in the time zone of the photo's GPS location, so a Tokyo photo shows Tokyo time.
- **Live photos.** A short clip next to a still with the same name becomes that photo's motion. It's hidden from the grid and plays when you press **LIVE** or `L`.
- **Trashed items** in the export are skipped.
- **HEIC and RAW.** On macOS these are decoded with `sips`. Videos get thumbnails and metadata from `ffmpeg`/`ffprobe`.
- **Watching.** New, changed and deleted files in any source folder show up in the open app within a few seconds.

## Commands

```
photobox serve [folders...] [--port 4567] [--open] [--data ~/.photobox]
               [--listen <address>] [--remote-port <n>] [--tls-cert <file> --tls-key <file>]
photobox scan [folders...]          # index once (all known folders if none are given), then exit
photobox export <dest> [folders...] [--dry-run]   # copy everything into <dest>/YYYY/MM/
npm test                            # all tests; the fake-Takeout import runs on macOS with ffmpeg
npm run fake-takeout -- fixtures/demo   # build a demo export that hits every edge case
```

The library database and thumbnail cache live in `~/.photobox`. You can change this with
`--data` or `PHOTOBOX_DATA`. Deleting that folder resets Photobox and leaves your photos alone.

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
- **Reorganize freely.** Move or rename files inside the export, or sort them into folders of
  your own. The next export finds them by content instead of copying them again. Originals in a
  Photobox source folder inside the export (a Takeout unpacked there, say) don't count.
- **`photobox-export.json`** records each file's albums, favorite flag, description, people,
  place and exact time, and what has been exported (if it gets lost, files already in place are
  recognized by content). Add the folder, or a copy of it on another machine, to Photobox and
  all of that comes back, also for files you've moved or renamed. A photo in several albums is
  one file there and is listed in all of them.

`--dry-run` lists what would be copied. Folders given to `export` are added and scanned first.
Without folders it rescans the library's folders, or, if Photobox is running, exports that
running library as it is.

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

## Desktop app

`desktop/main.js` runs the library server in an Electron utility process, so imports
never freeze the window, and shows the same web UI in a native window. On top of
the browser version it adds:

- ⌘O, and adding folders by dragging them onto the window
- Dock progress while importing
- links that open in your normal browser
- a window size and position that are remembered between launches
- folder watching that keeps running after you close the window, until you quit with ⌘Q

The app and `photobox serve` use the same library in `~/.photobox`. Only one of
them indexes it at a time: whichever starts first owns it, and the other just shows
that server (the CLI prints its URL, and the app opens it in its window).

Videos need ffmpeg (`brew install ffmpeg`). The app finds Homebrew's ffmpeg even when
it's opened from Finder.

## Keyboard (viewer)

`←` `→` browse · `I` info · `F` favorite · `L` play live photo · `Esc` close

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
src/tls.js               Photobox's own CA and server certificate for --listen
public/                  the app: justified timeline, year scrubber, albums, viewer
public/pair.html, pair.js  the page a phone opens from the QR code
public/sw.js             service worker: installable app, cached thumbnails
```

## Security

The server binds to `127.0.0.1`. It rejects requests whose `Host` isn't localhost,
which blocks DNS rebinding, and it only accepts JSON for writes, so another website
can't post to it from your browser.

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
- Phone backup. Browsing from a phone works (see above). [docs/android-plan.md](docs/android-plan.md)
  is the plan for the rest of an open-source Android replacement for Google Photos: backup with
  proof, and freeing space safely.
- `--listen` in the desktop app. For now, start network access with `photobox serve --listen`.
