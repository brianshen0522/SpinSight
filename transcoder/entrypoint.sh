#!/bin/sh

: "${STREAM_URL:?STREAM_URL environment variable is required}"
: "${RECONNECT_WAIT:=3}"

mkdir -p /hls

echo "[transcoder] Source        : $STREAM_URL"
echo "[transcoder] Output        : /hls/stream.m3u8"
echo "[transcoder] Reconnect wait: ${RECONNECT_WAIT}s"

# NOTE: -reconnect* flags are HTTP-only in ffmpeg and do NOT work for RTMP.
# Reconnection is handled by the while loop below.
#
# -c:v copy assumes the source is H.264 (standard for RTMP).
# If ffmpeg reports a codec error, change to:
#   -c:v libx264 -preset ultrafast -tune zerolatency -g 30

attempt=0
while true; do
    attempt=$((attempt + 1))
    echo "[transcoder] Attempt #${attempt} — connecting..."

    ffmpeg \
      -loglevel warning \
      -stats \
      -rw_timeout 10000000 \
      -i "$STREAM_URL" \
      -c:v copy \
      -an \
      -f hls \
      -hls_time 2 \
      -hls_list_size 10 \
      -hls_flags delete_segments+append_list+independent_segments \
      -hls_segment_filename /hls/seg%05d.ts \
      -hls_allow_cache 0 \
      /hls/stream.m3u8 || true

    echo "[transcoder] ffmpeg exited — waiting ${RECONNECT_WAIT}s before retry..."
    sleep "$RECONNECT_WAIT"
done
