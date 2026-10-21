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

Then open http://localhost:4567. In either version you can add folders with **Add folder**.
In the desktop app you can also press ⌘O or drag folders from Finder onto the window.

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
photobox scan <folders...>          # index once, print a summary, exit
npm test                            # sidecar unit tests + end-to-end import of a fake Takeout
npm run fake-takeout -- fixtures/demo   # build a demo export that hits every edge case
```

The library database and thumbnail cache live in `~/.photobox`. You can change this with
`--data` or `PHOTOBOX_DATA`. Deleting that folder resets Photobox and leaves your photos alone.

## Desktop app

`desktop/main.js` runs the library server in an Electron utility process, so imports
never freeze the window, and shows the same web UI in a native window. On top of
the browser version it adds:

- a native folder picker, ⌘O, and adding folders by dragging them onto the window
- Dock progress while importing
- **Show in Finder**, with links opening in your normal browser
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
bin/photobox.js          CLI: serve / scan
src/app.js               starts library + indexer + watcher + server; single-instance lock
desktop/main.js          Electron shell: window, menu, native dialogs, Dock progress
desktop/server-process.js  library server inside an Electron utility process
desktop/preload.cjs      the small native API the UI may use (window.photobox)
src/takeout/sidecar.js   Takeout sidecar matching (pure, unit-tested)
src/indexer.js           walk → match sidecars → hash/dedupe → metadata → thumbnail → SQLite
src/metadata.js          EXIF (exifr) and video metadata (ffprobe)
src/dates.js             timestamp parsing, filename dates, GPS → time zone
src/thumbs.js            thumbnails/previews (sharp, sips and ffmpeg fallbacks)
src/db.js                SQLite schema + queries (node:sqlite, no native build)
src/watcher.js           chokidar → debounced rescans of the affected folders
src/server.js            local HTTP API, localhost only
public/                  the app: justified timeline, year scrubber, albums, viewer
```

## Security

The server binds to `127.0.0.1`. It rejects requests whose `Host` isn't localhost,
which blocks DNS rebinding, and it only accepts JSON for writes, so another website
can't post to it from your browser.

## Not yet

- Code signing and notarization, auto-updates, and a Windows or Linux build. The config is there, but it hasn't been tried.
- Search, map view, face grouping, place names (reverse geocoding).
- Reading `.zip` parts directly (extract them first).
- Transcoding for videos the browser can't play (`.avi`, `.mts`, …). Those show a thumbnail and **Show in Finder**.
- Writing metadata back into files. Favorites you set in Photobox live in its database.
