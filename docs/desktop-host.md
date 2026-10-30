# The macOS background host

Install the DMG's `Photobox.app` in Applications and open it once. The installed app
registers **Launch at Login** on first launch. After login it runs in the menu bar;
there is no terminal/server command to keep open. Closing the library window leaves
the host running. **Quit Photobox** stops its own host; it starts again on the next
login/open. The menu's Launch at Login checkbox and macOS Login Items control startup.

The menu bar shows receiving bytes, integrity verification, import/indexing and
export progress. A percentage/ring appears when progress is measurable. Error status
includes unavailable destinations and integrity failures; completed export counts
are distinct from bytes received. Status polling runs in the main process, not the
renderer, so it continues without a library window.

## Controls

- Open Library / Open in Browser.
- Connect a Phone: opens the browser/native Android pairing dialog.
- Choose Export Folder: applies/persists a validated destination without restarting.
- Show Export Folder / Show Library Data / Show Logs.
- Retry Backup / Refresh Metadata.
- Phone Access over HTTPS: enables/disables the paired listener and restarts the
  host gracefully; unfinished uploads resume rather than being considered backed up.
- Restart Host, Launch at Login and Quit.

Fresh installations use localhost port 4567, paired HTTPS on port 4568, and `~/Photos`
for exports. A new default export directory is created once. A previously configured
missing destination is never recreated/adopted: the existing marker check protects
against unplugged drives. An isolated `PHOTOBOX_DATA` development override uses a
sibling export directory instead of the user's Photos folder.

## Persistent data and recovery

`~/.photobox/host.json` keeps host ports/listen address, export destination and optional
custom TLS file paths. CLI overrides/environment can configure the initial service;
normal desktop worker restarts use the saved choices. `desktop.json` tracks initial
login registration, `window.json` tracks window placement, and `desktop-runtime/`
contains the Electron profile. Upload originals remain in `inbox/`.

Logs are in `~/.photobox/logs/desktop.log`, rotated at 5 MiB with two older files.
Private keys/tokens are not logged intentionally. Review private paths before sharing.

If the utility process exits unexpectedly, the tray stays alive and restarts it with
bounded backoff. Failed status checks are visible, not reported as up to date. A
running CLI host is initially reused; the menu can restart a current CLI host into
desktop management. An older CLI without management APIs must be quit once. The app
never starts a second indexer against an already running library.

macOS can require user approval for a login item; check System Settings → General →
Login Items if the checkbox cannot enable it. Registration only occurs from an
installed packaged app, not a development build or isolated desktop smoke test.

FFmpeg/ffprobe are optional external video tools; the app finds standard Homebrew
installations when launched from Finder. Photo backup, indexing, HTTPS and export
are included in the app. Public Developer ID signing/notarization is documented in
[releasing.md](releasing.md).
