#!/usr/bin/env bash
set -euo pipefail

fixture_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.6" \
  -ac 2 -c:a pcm_s16le "$fixture_dir/alex-scene-clean.wav"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.2" \
  -f lavfi -i "anullsrc=sample_rate=8000:channel_layout=mono:duration=0.2" \
  -f lavfi -i "sine=frequency=660:sample_rate=8000:duration=0.2" \
  -filter_complex "[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]" -map "[out]" \
  -ac 2 -c:a pcm_s16le "$fixture_dir/alex-scene-omission.wav"
