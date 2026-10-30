# Third-party software

Photobox's application code and generated artwork are MIT licensed. Its dependencies
retain their own licenses and copyright notices; see their packaged `LICENSE`,
`COPYING`, package metadata, and the exact versions in the lockfiles.

## Desktop and host

- **Electron** — MIT; includes Chromium, Node.js, SQLite and other third-party code.
  Electron's `LICENSE` and `LICENSES.chromium.html` ship in `Contents/Resources/licenses/`.
  Sources/notices: <https://github.com/electron/electron>.
- **sharp** — Apache-2.0. The bundled **libvips** and several dependencies are used
  under LGPLv3 via the LGPLv2/2.1 "any later version" clause and are dynamically
  linked by sharp. The `@img/sharp-*` / `@img/sharp-libvips-*` packages identify
  their binary versions and include upstream notices. Matching build scripts and
  dependency sources: <https://github.com/lovell/sharp-libvips> and
  <https://github.com/libvips/libvips>. Photobox does not modify those libraries.
  A source build can substitute/rebuild these dependencies with `npm`; replacing
  libraries inside an installed signed app requires signing the modified app again.
  GPLv3/LGPLv3 texts, the binary's dependency-version manifest and its library/license
  table are included in `Contents/Resources/licenses/`. That table also identifies
  BSD, MIT, MPL and other dependencies within the libvips distribution.
- Express, chokidar, exifr, node-forge, qrcode, tus server/file-store, srvx and
  tz-lookup retain their published licenses. Their package metadata/notices are
  included with the production dependencies in the app archive.

FFmpeg/ffprobe are optional external programs, not bundled in the DMG. If installed,
Photobox invokes them for video previews/metadata. Their applicable build/license
terms belong to that separately installed distribution. macOS `sips` is an OS tool.

## Android and build tools

AndroidX, Compose, Room, WorkManager, ZXing/JourneyApps, OkHttp, Kotlin and Kotlin
serialization retain their upstream licenses. Gradle and Android build tooling
are development dependencies, not part of the host server. See the pinned Gradle
files and dependency metadata for exact versions.

No user photo libraries, Takeout exports, credentials or test-device data are
included in release artifacts. Test media is generated synthetically.
