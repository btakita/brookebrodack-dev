#!/usr/bin/env bash
# Subscribe to a YouTube channel's Atom feed via WebSub (PubSubHubbub).
#
# Usage:
#   YOUTUBE_CHANNELID=UC... WEBSUB_SECRET=... WORKER_URL=https://brookebrodack-websub.<account>.workers.dev ./subscribe.sh
#
# The YouTube Atom feed URL is:
#   https://www.youtube.com/xml/feeds/videos.xml?channel_id=<CHANNEL_ID>
#
# Google's WebSub hub is:
#   https://pubsubhubbub.appspot.com/subscribe

set -euo pipefail

: "${YOUTUBE_CHANNELID:?Set YOUTUBE_CHANNELID}"
: "${WEBSUB_SECRET:?Set WEBSUB_SECRET}"
: "${WORKER_URL:?Set WORKER_URL (e.g., https://brookebrodack-websub.<account>.workers.dev)}"

TOPIC="https://www.youtube.com/xml/feeds/videos.xml?channel_id=${YOUTUBE_CHANNELID}"
HUB="https://pubsubhubbub.appspot.com/subscribe"

echo "Subscribing to: ${TOPIC}"
echo "Callback URL:   ${WORKER_URL}"
echo "Hub:            ${HUB}"
echo

curl -s -o /dev/null -w "HTTP %{http_code}\n" \
  -X POST "${HUB}" \
  -d "hub.callback=${WORKER_URL}" \
  -d "hub.topic=${TOPIC}" \
  -d "hub.verify=async" \
  -d "hub.mode=subscribe" \
  -d "hub.secret=${WEBSUB_SECRET}" \
  -d "hub.lease_seconds=864000"

echo
echo "Subscription request sent. The hub will verify by sending a GET to your worker."
echo "Note: YouTube WebSub leases expire. Re-run this script periodically (e.g., every 7 days)."
