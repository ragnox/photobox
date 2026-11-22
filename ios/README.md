# Photobox for iPhone

A native backup client for iPhone and iPad, iOS 17 or newer. It does what
[Photobox for Android](../android/README.md) does, over the same
[backup protocol](../docs/backup-api.md): it copies the original files of your photos and
videos to Photobox on your computer, over your Wi-Fi or VPN. SwiftUI, PhotoKit and
Background Tasks; no other dependencies and no telemetry.

- `PhotoboxKit/` is a Swift package with the protocol, trust, tus uploads, host
  discovery and the backup engine. It has no UIKit or PhotoKit in it, so its tests run on a Mac.
- `Photobox/` is the app: PhotoKit, the Keychain, background runs and the screens.

## Build

Open `Photobox.xcodeproj` in Xcode 16 or newer and run the **Photobox** scheme. From the
command line:

```sh
xcodebuild -project ios/Photobox.xcodeproj -scheme Photobox -destination 'platform=iOS Simulator,name=iPhone 17' build
```

For a real iPhone, choose your team under **Signing & Capabilities** (a free Apple account
works; the app then runs for 7 days before it needs installing again). Change the bundle
identifier `local.photobox.ios` if Xcode says it is taken.

## Tests

```sh
cd ios/PhotoboxKit && swift test
```

The tests start the real Node host (`scripts/android-test-host.js`, with a temporary,
synthetic library on 127.0.0.1), so run `npm install` at the repository root first. They
cover:

- pairing, which checks the QR code's certificate before the code goes anywhere;
- TLS, which trusts only the paired authority or pinned certificate, checks the host name or
  IP address, and follows no redirects;
- a host found at a new address, where another host never sees the token;
- tus uploads that resume at the host's offset, including after the host closed an idle
  connection;
- receipts, which count a photo only once it's exported;
- the backup engine end to end, including a run that is stopped mid-file (as iPhone ends a
  background task) or past its deadline, and goes on later;
- photos deleted in Photobox, and reporting what the phone did with them.

The app itself has a UI test that runs in the iOS Simulator:

```sh
ios/test-ui.sh "iPhone 17"
```

It starts the same throwaway host and adds a few made-up photos and a video to the
simulator's Photos library. Then it pairs by pasting the pairing data and waits until
everything is backed up and filed. Last, it deletes a photo on the host, deletes it on the
"phone" through iPhone's own confirmation, and checks that the host's Deleted list shows it as
trashed there. A debug build started with `-PhotoboxReset YES` begins unpaired, with an empty
queue.

## Connect and back up

1. Start the host with network access and an export folder, for example
   `npm start -- --listen 0.0.0.0 --backup-dir ~/Photos`.
2. On the computer, choose **Connect a phone → Photobox for iPhone**.
3. In the app, name the phone and tap **Scan the code**. Without a camera, open **Copy
   pairing data** on the computer and tap **Paste** in the app.
4. Allow access to your photos: **Full Access** backs up all of them, **Limited Access** only
   the ones you choose.

The app backs up when you open it. It also backs up in the background when iPhone lets it,
often at night while charging; **Background App Refresh** must be on for Photobox, and Low
Power Mode holds it back. For the first backup of a big library, keep the app open on the
charger.

## What it backs up

- **Each photo's or video's original file**, as the camera made it: HEIC, JPEG, ProRAW DNG,
  MOV and so on, with all its metadata.
  - Edits made in Photos are kept apart from the original and aren't backed up.
  - A photo whose original is in iCloud only (**Optimize iPhone Storage**) is downloaded for
    the backup.
- **The video of a Live Photo**, as a file of its own next to the still.
  - In the export folder they share a month folder and a name, and the timeline shows them as
    one Live Photo.
  - In the host's inbox each upload has a folder of its own, so a library without an export
    folder shows them as two items.
- **Screenshots**, unless you turn them off.
- **Hidden photos**.
- Not shared albums or photos synced from a computer, which aren't yours to back up from
  this phone.

A photo counts as backed up only once the host has received it, indexed it **and** exported
it. Until then the app lists it as **Waiting for your computer**. The app never
changes a photo.

## How a backup runs

Each original is handled the way Photobox for Android handles one:

1. It is exported from Photos to a file in the app's caches.
2. The file is hashed with SHA-256, and the host is asked whether it has it already.
3. A tus upload is created, and its location is saved before the first byte.
4. The file goes in chunks. After an interruption, the host's offset (HEAD) says where to go on.
5. The host's receipt is kept.

The queue is kept in SQLite in the app's Application Support folder. A new version of an
original is a new photo, and progress made for another pairing counts for nothing. A run that
runs out of time, because iPhone ends a background task, goes on where it stopped next time.

## Trust and credentials

The QR code holds the host address, a one-time code, its expiry and the host's public trust
certificate with its SHA-256. The app checks the certificate before it redeems the code. TLS
then trusts only that certificate, with the usual host-name or IP-address check. There is no
trust-all fallback and no redirects.

The paired host's address, this phone's token and the trust anchor are kept in the Keychain on
this device only. **Disconnect from this computer** forgets them; disconnect the phone on the
computer too, to revoke its token.

When nothing answers at the saved address (the Wi-Fi router gave the computer another one),
the app looks for the hosts the local network announces (`_photobox._tcp`). It tries each with
the paired trust anchor, so another host never sees the token. This needs the **Local Network**
permission, which iPhone asks for the first time.

## Photos deleted in Photobox

When you delete a photo in Photobox, the next run learns of it and doesn't upload it again.
The app shows it under **Deleted in Photobox** and posts a quiet notification.

- **Delete from this iPhone**: iPhone asks you first, then the photo goes to Recently Deleted.
  A Live Photo goes as a whole.
- **Keep**: the photo stays on the phone.

The app tells the host what you did, and the host shows it on its Deleted list. A photo that is
already gone from the phone counts as deleted.

## Not yet

- **A real iPhone.** The app was built and tried on the iOS Simulator only. What iOS allows in
  the background on a phone still needs trying there: a large first backup, the screen locked,
  Low Power Mode, iCloud-only originals, the Local Network permission.
- **Big videos while the app is suspended.** These would need a background `URLSession`; for
  now they continue in the next run.
- **Freeing space on the phone** for photos that are safely backed up.
