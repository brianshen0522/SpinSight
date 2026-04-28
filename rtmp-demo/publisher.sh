#!/bin/sh

set -eu

while true; do
    ffmpeg \
        -re \
        -stream_loop -1 \
        -i /data/output.mp4 \
        -an \
        -c:v libx264 \
        -preset veryfast \
        -tune zerolatency \
        -pix_fmt yuv420p \
        -g 50 \
        -f flv \
        rtmp://rtmp:1935/live/output || true
    echo "publisher retrying in 2s..."
    sleep 2
done
