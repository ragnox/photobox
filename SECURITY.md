# Security

Photobox is local-first. The local management API binds to loopback and checks the
Host header/JSON writes. Phone access is a separate paired HTTPS listener. Device
tokens are random, stored hashed on the host and encrypted with Android Keystore
on the phone. TLS trust is bootstrapped from the computer's native QR payload.

The macOS application is an unsandboxed desktop host: it needs access to selected
photo folders, its library data and export directory. Its renderer has sandboxing,
context isolation and no Node integration. Native IPC is restricted to its own
local library window. Management/configuration/shutdown routes are unavailable to
paired remote devices. Menu-bar progress does not substitute for full-hash receipts.

## Reporting

Use GitHub's private vulnerability reporting when enabled on the repository:
<https://github.com/ragnox/photobox/security/advisories/new>. If that is unavailable,
open an issue requesting a private contact without publishing exploit details or
user data. Do not include pairing payloads, tokens, private keys, personal media or
unredacted logs. Maintainers should enable private reporting when publishing the repo.

Only the latest source/release line is maintained. Desktop updates are installed
manually; there is no silent updater or third-party telemetry.

## Dependency tracking

Dependabot tracks npm, Gradle and GitHub Actions. At this revision npm reports
GHSA-86w9-cpqp-85rv for node-forge 1.4.0, with no fixed upstream npm version.
Photobox uses forge to construct its own local certificates, not to verify incoming
RSA signatures; TLS and certificate verification use Node/OpenSSL and platform TLS.
This unused verification path is tracked rather than hiding the audit result.
Upgrade/remove that dependency when an appropriate upstream fix is available.
