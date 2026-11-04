# Archives: where your photos and their history live

Status: design, partly implemented (2026-10-30). Today the list of source folders and the phone
backup inbox live in the library database in `~/.photobox` (an archive's in
`~/.photobox/cache/<archive id>/`), and `photobox export` writes `photobox-export.json` into the
export folder. Done:

- Named sources with "From" in the info panel and the timeline filter by source, albums per
  source, and same-shot versions, with `.photobox/superseded/` in the export folder.
- Step 1, the archive basics: `photobox init`, `.photobox/archive.json`, finding the archive from
  the current folder or `--archive`, the library cache per archive id in
  `~/.photobox/cache/<id>/`, `export` into the archive, and skipping photo-app libraries. The
  archive and any folder holding it are refused as sources. The desktop app still opens only
  the library in `~/.photobox`, and paired phones are still kept in the library database, so
  each archive has its own.
- Open question 1, decided A: `photobox sort` moves the photos already in an archive into
  `YYYY/MM`. Folder names become albums. Exact duplicates go to `.photobox/superseded/`, and
  every move is in `.photobox/history.jsonl` (`file-sorted`, `file-superseded`,
  `folder-removed`), so `photobox sort --undo` puts them back. Sorted files are entered in
  `photobox-export.json` with `sortedFrom`.
- Step 7, export folders: `photobox merge <folder>` brings a library exported before the archive
  existed into it. Content the archive has gets the folder's albums, people and favorites; the
  rest comes in as hard links (copies from another disk), with `mergedFrom` in the manifest. The
  archive's older versions of photos the folder has better ones of go to `superseded/`. Every
  step is in the history (`file-added`, `file-merged`, `file-superseded` with the entries it
  replaced), and `photobox merge --undo` reverses the last merge; sorts and merges are undone
  newest first.
- Step 7, libraries (2026-10-30): `photobox adopt` makes the library in `~/.photobox` an
  archive's library (a consistent copy of the database plus its thumbnails), so its sources,
  names, favorites, versions and paired phones carry over; the old library stays. An archive's
  library always has the archive's own photos as a source Photobox manages: the files the
  manifest lists, read with the manifest's albums and dates, rescanned when the manifest
  changes. A manifest's date replaces only a worse one, so a sorted file's own guess doesn't
  undo a Google sidecar's exact time, and shot keys come from a file's real name
  (`originalName`), so an export's `IMG_1~2 (2).jpg` is still an edited copy. The app shows the archive's file as the copy in the library folder, leaves the
  archive out of "From" unless a photo came from nowhere else, and lists an album the archive
  and a source share once, as the archive's. `photobox serve` saves the archive it runs in to
  `~/.photobox/host.json`, and the desktop app opens that one. Exports, sorts and merges hold
  `<folder>/.photobox-writing` while they write, so the app's phone-backup export and a nightly
  export into the same archive take turns.

An **archive** is a folder of photos that Photobox organizes and keeps a history for, for
example `~/Pictures`. Every photo is copied into the archive once, from the sources you allow.
A backup copy of the archive, on an external drive for example, is a complete archive itself.

Photobox, the program, stays neutral: it holds no user data and works with any archive on any
machine. Like git, it keeps an archive's own data in a folder inside that archive and the
per-user, per-machine data in the home folder.

## Platforms

First: **macOS** for the archive and the app, and **Android** for phone backup. Windows and
iPhone come later. The design keeps them possible:

- Paths inside an archive use `/` and Unicode NFC. macOS volumes are usually case-insensitive
  and store names decomposed (NFD), so names are compared normalized.
- On macOS, copies within one APFS volume are clones and take no extra space at first
  (`photobox export` already copies with `COPYFILE_FICLONE`).
- On macOS, reading a removable drive needs the user's one-time permission for the process that
  reads it (Files & Folders > Removable Volumes). A scheduled backup to an external drive has to
  run as an app that holds that permission.
- Later, Windows: `.photobox` has to be given the hidden attribute (a leading dot does not hide
  a folder there), and the home folder data goes to `%USERPROFILE%\.photobox`.
- Later, iPhone: a client of the same host protocol, with PhotoKit and iOS background limits
  (see [the phone backup plan](phone-backup-plan.md)).

## Contract

- The archive is the source of truth. Everything needed to understand it lives inside it:
  where each photo came from, its albums, favorites, descriptions, dates and places. Deleting
  Photobox's cache loses nothing that can't be rebuilt from the archive.
- One file per photo. Identical content is stored once, and a lower-quality copy of the same
  shot is not stored a second time (see [Duplicates](#duplicates)).
- Photos come only from sources that are named and allowed for this archive.
- Photobox never deletes a photo from an archive by itself. A file it replaces is moved aside.
  A photo you delete goes to the Trash, and the history records it (`file-deleted`).
- The archive contains no secrets (private keys, device tokens), because it gets copied to
  backup drives and other machines.

## Layout

| Where | Contains | Rebuildable | Travels with the archive |
| --- | --- | --- | --- |
| `<archive>/YYYY/MM/` | the photos and videos | no | yes |
| `<archive>/.photobox/` | archive id, sources, history, manifest, archive settings | no | yes |
| `~/.photobox/` | known archives, app preferences, cache per archive, HTTPS keys, paired devices | the cache, yes | no |
| the app | code only | | |

### Inside the archive

```
<archive>/.photobox/
  archive.json     {"version": 1, "id": "<random uuid>", "createdAt": "..."}
  settings.json    settings for this archive; they override the home folder's (optional)
  sources.json     the allowed, named import sources
  manifest.json    the current state of every file (today's photobox-export.json)
  history.jsonl    append-only log of every import and every change
  inbox/           verified phone uploads waiting to be filed
  superseded/      files replaced by a better version, never deleted automatically
```

- **Finding the archive.** Photobox walks up from the folder you open to the nearest folder
  with `.photobox/archive.json`, the way git finds `.git`. `photobox init <folder>` creates
  one. A folder outside any archive can still be browsed, as today, without history.
- **Archive id.** A random id that copies keep. Photobox recognizes a backup drive as a copy
  of the same archive, and keeps the caches of two different archives apart.
- **Paths** inside `.photobox/` are relative to the archive root (`/` separators, Unicode
  NFC). Paths of sources outside the archive are absolute but only informative: on another
  machine a source can be missing, and the history still says what came from it.
- The scanner already skips hidden folders, so `.photobox/` is never mistaken for photos.

### In the home folder

```
~/.photobox/
  config.json              known archives (id -> last path), preferences
  cache/<archive id>/      library.db, thumbs/, previews/ - rebuilt when missing
  uploads/                 partial phone uploads, before they are verified
  tls/                     certificate authority and server key for network access
  devices.json             paired devices: token hashes, and the archive each one backs up to
```

Settings resolve like git config: the archive's `settings.json`, then `~/.photobox/config.json`,
then built-in defaults. Without any archive, Photobox works as it does today, with everything
in `~/.photobox`.

## Sources

`sources.json` lists where photos may come from. Each source has a stable id and a name that
Photobox shows wherever it says where a photo came from.

```json
{
  "version": 1,
  "sources": [
    { "id": "google-main", "name": "Google Photos (main account)", "kind": "takeout",
      "path": "/Users/me/Takeout/main/2026-01-10", "addedAt": "2026-01-10T18:00:00Z" },
    { "id": "google-second", "name": "Google Photos (second account)", "kind": "takeout",
      "path": "/Users/me/Takeout/second/2026-03-02", "addedAt": "2026-03-02T21:00:00Z" },
    { "id": "phone-sync", "name": "Phone (Syncthing)", "kind": "folder",
      "path": "/Users/me/Phone/Camera", "addedAt": "2026-01-11T09:00:00Z" },
    { "id": "phone-app", "name": "Phone (backup app)", "kind": "device",
      "device": "<install id>", "addedAt": "2026-01-12T20:00:00Z" }
  ]
}
```

- **Adding a source is explicit**, with `photobox source add <name> <path>` or in the app, and
  it shows an import preview before anything is copied: new, already in the archive, same shot
  in better or worse quality, trashed in the export, skipped.
- **Broad folders are refused** unless forced: the home folder, Desktop, Downloads, a whole
  volume, the archive itself, or a folder that contains it. A Downloads folder full of icons,
  renders and saved web pages is not a photo source.
- **Photo-app libraries and app bundles are skipped:** `*.photoslibrary`, `*.photolibrary`,
  `*.migratedphotolibrary`, `*.app`. Reading the originals of an Apple Photos library would be
  a source kind of its own, read-only (later).
- **One source per Google account.** A newer Takeout of the same account updates that source's
  path, and the history records the export id (`takeout-20260302T120000Z`) with every import.
- **Removing a source** stops future imports from it. Files already imported stay, and the
  history keeps their origin.

## History and origins

Two records, both inside the archive:

1. **`history.jsonl`** is append-only and never rewritten, one JSON object per line. Events:
   `source-added`, `source-removed`, `import-started`, `file-added`, `file-merged` (the same
   content was already there; this adds an origin), `file-version` (the same shot with other
   bytes), `file-superseded`, `file-moved` (the user reorganized the archive),
   `import-finished`. A file event records the time, the source id, the export id for a
   Takeout, the original path within the source, size, SHA-256, the archive path, and what the
   source said about the photo: album, favorite, archived, description, people, time taken,
   place.

   ```json
   {"t":"2026-03-02T21:14:03Z","event":"file-added","source":"google-second","export":"20260302T120000Z","from":"Takeout/Google Photos/Lisbon 2024/IMG_0412.jpg","sha256":"9f2c...","size":3412870,"to":"2024/07/IMG_0412.jpg","album":"Lisbon 2024","favorite":true,"takenAt":"2024-07-21T13:18:58+01:00"}
   {"t":"2026-03-02T21:14:03Z","event":"file-merged","source":"google-second","export":"20260302T120000Z","from":"Takeout/Google Photos/Photos from 2024/PXL_20240802_093015120.jpg","sha256":"41ab...","to":"2024/08/PXL_20240802_093015120.jpg"}
   ```

2. **`manifest.json`** is the current state, rewritten atomically. It has an entry per archive
   file, as `photobox-export.json` does today, plus `origins`: one per source the photo came
   from, with that source's original path, albums, favorite, archived and description. Same-shot
   variants are listed under `versions`. The manifest is the fast index and the history is the
   audit trail: if they disagree, the history wins, and replaying it rebuilds the manifest.

In the app:

- The info panel says where a photo came from: "From: Google Photos (second account), album
  Lisbon 2024 · Phone (Syncthing)".
- The timeline can be filtered by source, which also gives "only in this source" and "in both".
- Albums are per source: two accounts' "Untitled" albums stay two albums.
- Favorite and archived come per origin. The combined view shows a photo as a favorite if any
  origin marked it, and hides it as archived only if every origin archived it. Favorites set in
  Photobox are recorded as Photobox's own origin.

## Duplicates

Three levels:

1. **Identical bytes** (full SHA-256): one file, and each further copy adds an origin. This
   works today.
2. **The same shot with different bytes**, for example recompressed by a cloud service,
   re-exported, or with rewritten metadata.
   - **Candidates** have the same capture time to the sub-second (EXIF `DateTimeOriginal` and
     `SubSecTimeOriginal`), the same camera and the same shape; videos the same creation
     second, shape and length (within half a second). A 64-bit difference hash of the
     thumbnail confirms them (Hamming distance of 8 or less). Pixel renderings of one capture
     (`.PORTRAIT-01.COVER`, `.ACTION_PAN-02.ORIGINAL`) and edited copies (`-edited` in any
     language, the phone's `~2`) count as shots of their own. Two files of one source are
     versions only when the camera recorded sub-seconds and the hashes differ in 3 bits or
     less (a Takeout's album copy next to its year-folder copy); otherwise they are a burst.
     A group only takes in a file that matches every file already in it. Measured on a real
     library: 19 groups shared a capture time and camera; 3 were versions (album copies),
     the rest renderings, edits or different pictures.
   - **The archive keeps one file per shot, the best version:** a phone backup original, else
     the largest file. Other versions are recorded as origins, with their SHA-256, and are not
     copied. Favorites, archive state, descriptions, people and places carry over to it.
   - **If a better version arrives later,** it is copied in under a new name, and the old file
     moves to `.photobox/superseded/` with a history event. A new name, because a backup copy
     that never overwrites would otherwise keep the old file under the shared name.
   - **"Not the same photo"** in the viewer keeps a pair apart for good (by SHA-256).

   Observed when comparing a second Google account's Takeout with an existing archive: of
   2,775 distinct files, 424 were byte-identical, but 1,317 had the same name and different
   bytes. Samples had the same camera and dimensions, and sizes differing by up to 5×. Content
   hashing alone would have stored all 1,317 twice.
3. **The import preview** counts every class before anything is copied. For Takeout zips it
   can work without extracting, by matching each entry's size and CRC-32 from the zip
   directory against the archive.

## Google Takeout

- **Folder keys per export.** `takeoutFolderKey` drops everything above `Takeout/`, so the
  separately extracted parts of one export merge. But two different exports in one folder
  also merge, and then sidecars and album titles of two accounts can mix. Key folders by
  `<export id>/<path below Takeout>` when the folder above `Takeout` is named
  `takeout-<export id>-<n>-<part>`, and by the parent folder of `Takeout` otherwise.
- **Trashed items** (the `Bin` folder, `trashed` in the sidecar) are skipped, as today.
- **Album titles belong to their source.** Albums of different accounts never merge.
- **The Locked Folder is not in a Takeout.** Its photos have to be moved out on the phone first.

## Phone backup

Builds on [the phone backup plan](phone-backup-plan.md).

- **Paired devices are machine-local** in `~/.photobox/devices.json`, like the HTTPS keys,
  because a phone pins this computer's certificate. Each device is mapped to one archive, and
  that archive's `sources.json` lists it by its stable install id, so where a photo came from
  stays in the archive.
- **Uploads move into the archive.** Partial uploads stay in `~/.photobox/uploads/`. Verified
  originals move into `<archive>/.photobox/inbox/`, on the same volume, with an atomic rename,
  and are then filed into `YYYY/MM` as an import from the device's source. Originals never live
  in the cache, so deleting `~/.photobox` cannot lose them.
- **`/api/assets/check` asks the archive.** If the content (full SHA-256) is already there from
  any source, the phone gets a "present" receipt and the device is added as an origin. Nothing
  is uploaded again.
- **Device identity is the app's install id.** Pairing the same install again does not start
  its backup over.
- **Phone originals win.** They are usually the best version of a shot and replace recompressed
  cloud copies (level 2 above).

## Backup copies

A backup, on an external drive for example, is a copy of the whole archive folder, including
`.photobox/`:

- It only grows: new files are added, nothing is overwritten or deleted.
- `.photobox/` is copied last, so a copy never has history for files it lacks.
- Afterwards, every archive file must be on the copy with the same size, and later the same
  SHA-256 from the manifest.
- Opening the copy in Photobox on any machine shows the whole archive with its history.

## Migration from today

- `photobox-export.json` at the export root becomes `.photobox/manifest.json`. The old name is
  still read, and the old file is left in place for the first release.
- The source list in `~/.photobox/library.db` becomes `sources.json`. Names are asked for,
  with a suggestion from the path.
- Favorites, albums and origins in the database become the first history entries
  (`imported-from-library`).
- The phone inbox in `~/.photobox/inbox/` moves to `<archive>/.photobox/inbox/` after its
  hashes are verified.
- `--backup-dir` becomes the archive.

## Open questions

1. **Photos already in the archive folder** (decided 2026-10-29: A, as `photobox sort`). A
   folder like `~/Pictures` often holds years of
   photos already: loose files, trip folders, a messaging app's image folder, an older cloud
   download, a phone sync folder, an Apple Photos library.
   - **A. Move them into `YYYY/MM`.**
     - For: one structure. Folder names become albums. Every original path goes into the
       history, so the move can be undone. Duplicates found on the way go to `superseded/`.
       Moving within one volume needs no extra space.
     - Against: it changes a structure the user knows, and breaks other apps' references to
       those files (editor catalogs, shortcuts).
   - **B. Leave them where they are.** New imports go into `YYYY/MM`, and files already
     anywhere in the archive count as present and are not copied.
     - For: nothing the user placed is moved.
     - Against: the archive has two structures, and replacing a file with a better version of
       the same shot has to move a file the user put there. Reorganizing later means doing A
       anyway.

   Either way, photo-app libraries are skipped. A sync folder (Syncthing) inside the archive is
   a source, not archive content, and is best moved outside the archive first.
2. **Same-shot thresholds.** Set from one real library (see Duplicates); worth checking
   against other cameras, especially ones without sub-seconds.
3. **The combined-view rules** for per-origin favorites and archived (proposed above).
4. **Splitting `history.jsonl` per year** once it grows. At about 300 bytes per file event,
   100,000 photos are about 30 MB.

## Steps

1. Archive basics (done):
   - `photobox init`, `.photobox/archive.json`
   - finding the archive
   - the cache per archive id in `~/.photobox`
   - skipping photo-app libraries
2. Named sources with the allow rules and the import preview.
3. History, and origins in the manifest:
   - "From" in the info panel (done)
   - the timeline filter by source (done)
   - albums per source (done)
4. Takeout folder keys per export, tested with two exports in one folder.
5. Same-shot versions and superseded files (done for the library and export folders).
6. Phone backup:
   - the inbox in the archive
   - `check` against the archive
   - the stable install id
7. Migration of existing libraries and export folders. Sorting what is already in the archive
   (`photobox sort`), merging export folders into it (`photobox merge`) and taking over a
   library (`photobox adopt`, into the archive's cache in `~/.photobox`) are done; moving the
   sources into the archive's own `sources.json` is step 2.
