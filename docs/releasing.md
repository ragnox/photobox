# Building and releasing Photobox

## macOS DMG

On macOS, with Node.js 24 LTS:

```sh
npm ci
npm test
npm run test:ui
npm run dist:mac -- --arm64
npm run test:desktop -- --app dist/mac-arm64/Photobox.app
```

The DMG is `dist/Photobox-<version>-arm64.dmg`. Use `--x64` on an Intel runner for
an Intel build (`dist/mac/Photobox.app`). Build/test each architecture natively so
sharp/libvips and Electron match the packaged CPU. The DMG contains the app and an
Applications shortcut. Electron bundles the Node runtime; users do not need npm,
Node, Gradle or a terminal to run the host.

Local builds are ad-hoc signed. Downloaded builds without Developer ID signing and
notarization may require macOS Privacy & Security → Open Anyway. Public, notarized
builds require an Apple Developer account and the credentials below; the project
cannot create an Apple-issued signing identity from source alone.

## Developer ID and notarization

The build imports the P12 through electron-builder and notarizes after signing.
Keep these values in local environment/CI secrets, never in the checkout:

- `CSC_LINK`: base64 P12 or supported electron-builder certificate location.
- `CSC_KEY_PASSWORD`: P12 password.
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`: notarytool credentials.
- `PHOTOBOX_REQUIRE_SIGNING=1`: fail if signing or notarization is not configured.

The release workflow maps GitHub secrets `MAC_CERTIFICATE_P12` and
`MAC_CERTIFICATE_PASSWORD` to the CSC variables. Configure the Apple variables as
repository secrets. When a P12 is configured, the workflow requires notarization
credentials too instead of silently producing an unnotarized signed release.

Verify a signed/notarized bundle with `codesign --verify --deep --strict` and
`spctl --assess --type execute`. electron-notarize staples the accepted ticket.
Retest initial launch, login-item registration, menu-bar status, network pairing
and worker recovery from the installed app.

## Repository publication

The source contains an MIT license, third-party notices, contribution/security
guidance, issue/PR templates, Dependabot and CI. Repository visibility and pushing
local commits are separate maintainer actions; adding these files does not itself
publish a private GitHub repository. Before publication, inspect tracked files for
personal libraries, credentials and signing material. `.data/`, fixtures, build
outputs, local Android configuration and signing keys are ignored.

## Tagged releases

1. Update `package.json`/lockfile and document user-facing changes.
2. Pass host, desktop and Android checks. Keep physical-device acceptance distinct
   from JVM tests; see [android-verification.md](android-verification.md).
3. Create/push the matching `v<package-version>` tag.
4. The tag workflow builds/tests native arm64 and x64 DMGs, computes SHA-256 sums,
   and assembles a draft GitHub release. Review its generated notes and publish it.
5. State whether the artifacts are Developer ID signed/notarized or ad-hoc builds.

GitHub automatically offers the tagged source archive. Android's debug APK is an
ordinary CI artifact; Android release signing/F-Droid distribution and automatic
desktop updates remain separate work.
