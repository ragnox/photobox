# Contributing to Photobox

Thanks for helping build a photo library people can own and leave freely.

## Development

Use Node.js 24 LTS (minimum 22.13) and `npm ci`. Run `npm test` for the host,
metadata, export and pairing tests. The generated Takeout import suite uses macOS
`sips` and FFmpeg; install `ffmpeg` with Homebrew to exercise that suite on macOS.

For desktop development, isolate the library from your real photos:

```sh
PHOTOBOX_DATA="$PWD/.data/dev" npm run desktop
```

A fresh development data override gets a sibling export directory, `.data/dev-photos`.
The production app uses `~/.photobox` and `~/Photos` by default. Both hold originals;
neither is a disposable cache. Test media should be synthetic.

`npm run test:desktop` launches real Electron with isolated data/export paths,
opens/closes a native window, verifies the tray/HTTPS host, crashes the utility
process and verifies recovery/persistent settings. It does not register login items.

`npm run test:ui` tests the web UI end to end: it builds a throwaway library from
generated photos in two folders, runs the real indexer, export and server, and clicks
through the page in a hidden Electron window with real mouse and key events (sources,
albums per source, versions, the info panel, Show in Finder, copy, "Not the same photo").
It doesn't touch your library, Finder or clipboard. Add `PHOTOBOX_UI_SCREENSHOTS=<dir>`
to keep a screenshot of each step; a step that times out saves one and prints its path.

See [android/README.md](android/README.md) for JDK 17/SDK 36 Android development,
transport/Room tests and physical-device acceptance. See [docs/releasing.md](docs/releasing.md)
for DMG/signing/release builds.

## Changes and tests

- Keep the runtime small and consistent with the existing JavaScript ES modules.
- Preserve original bytes, backward-compatible manifests and existing user metadata.
- Cover meaningful failure boundaries for indexing, authentication, transfers and
  export. A received byte count is not a verified backup receipt.
- Keep UI work separate from index/import work; closing a window must not stop backup.
- Include documentation for changed data locations, defaults or protocol behavior.
- Never submit real Takeouts, photos, pairing payloads, tokens, private keys, signing
  certificates, local configuration or device database snapshots.

Contributions are under the project's [MIT license](LICENSE). Open an issue for
substantial architectural changes; small focused fixes can go straight to a pull request.
