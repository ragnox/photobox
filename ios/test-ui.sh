#!/bin/sh
# The iPhone app's UI test, in the iOS Simulator, against a throwaway Photobox host on this Mac:
# a temporary, synthetic library on 127.0.0.1 (scripts/android-test-host.js), never yours.
# It adds a few made-up photos and a video to the simulator's Photos library first.
#
#   ios/test-ui.sh ["iPhone 17"]
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
device=${1:-iPhone 17}
[ $# -gt 0 ] && shift # anything after the device goes to xcodebuild
work=$(mktemp -d)
cd "$root"

node scripts/android-test-host.js > "$work/host" &
host=$!
trap 'kill $host 2>/dev/null; rm -rf "$work"' EXIT INT TERM
for _ in $(seq 100); do [ "$(wc -l < "$work/host")" -ge 2 ] && break; sleep 0.2; done
pairing=$(sed -n 1p "$work/host")
local_url=$(sed -n 2p "$work/host")
[ -n "$local_url" ] || { echo "The test host didn't start" >&2; exit 1; }

mkdir "$work/media"
node --input-type=module - "$work/media" <<'EOF'
import sharp from 'sharp';
const [dir] = process.argv.slice(2);
const stamp = Date.now();
for (const [i, background] of [[220, 80, 60], [60, 140, 220], [80, 180, 90]].entries()) {
  const label = `<svg width="1200" height="900"><text x="80" y="480" font-size="120" fill="white">Test ${i + 1} · ${stamp}</text></svg>`;
  await sharp({ create: { width: 1200, height: 900, channels: 3, background: { r: background[0], g: background[1], b: background[2] } } })
    .composite([{ input: Buffer.from(label) }]).jpeg({ quality: 85 }).toFile(`${dir}/test-${stamp}-${i + 1}.jpg`);
}
EOF
if command -v ffmpeg >/dev/null; then
  ffmpeg -loglevel error -f lavfi -i "testsrc=size=640x360:rate=30:duration=2" -c:v libx264 -pix_fmt yuv420p "$work/media/test-video.mov"
fi

xcrun simctl boot "$device" 2>/dev/null || true
xcrun simctl bootstatus "$device" -b > /dev/null
xcrun simctl addmedia "$device" "$work"/media/*
xcrun simctl privacy "$device" grant photos local.photobox.ios 2>/dev/null || true

TEST_RUNNER_PHOTOBOX_PAIRING="$pairing" TEST_RUNNER_PHOTOBOX_LOCAL="$local_url" \
  xcodebuild test -project "$here/Photobox.xcodeproj" -scheme Photobox -destination "platform=iOS Simulator,name=$device" "$@"
