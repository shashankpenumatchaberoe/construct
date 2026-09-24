#!/usr/bin/env bash
# Add one or more audio tracks (music, voice-over) to a recorded guide video. Video is copied untouched.
#
#   packages/tools/media/add-audio.sh site/assets/video/01-ticket-to-story.webm \
#       --track music.mp3 --track voice.wav@4 --volume 0.35 --fade 2
#
#   --track FILE[@SECONDS[:VOLUME[:FADE]]]  audio to mix in, starting at SECONDS (default 0), with its own
#                           volume and fade when given (else --volume/--fade); repeat for more tracks
#   --volume N              level for all tracks, 1 = unchanged (default 0.6)
#   --fade N                fade each track in and out over N seconds (default 1.5)
#   --out FILE              output (default: <video>.audio.webm next to the input; input is never overwritten)
#
# Needs ffmpeg (apt install ffmpeg, or `brew install ffmpeg`); set FFMPEG=/path/to/ffmpeg to use another binary.
# Audio is trimmed to the video length. Any input format ffmpeg reads works (mp3, wav, m4a, ogg, ...).
set -euo pipefail

FFMPEG="${FFMPEG:-ffmpeg}"
command -v "$FFMPEG" >/dev/null 2>&1 || { echo "ffmpeg not found. Install it (apt install ffmpeg / brew install ffmpeg) or set FFMPEG=/path/to/ffmpeg." >&2; exit 1; }

video="${1:-}"; [[ -n "$video" && -f "$video" ]] || { sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
shift
volume=0.6; fade=1.5; out="${video%.*}.audio.webm"; tracks=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --track)  tracks+=("$2"); shift 2 ;;
    --volume) volume="$2"; shift 2 ;;
    --fade)   fade="$2"; shift 2 ;;
    --out)    out="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ ${#tracks[@]} -gt 0 ]] || { echo "give at least one --track FILE[@SECONDS]" >&2; exit 2; }
[[ "$out" != "$video" ]] || { echo "--out must differ from the input video" >&2; exit 2; }

# Video length in seconds (ffmpeg prints it on stderr; no ffprobe needed).
dur=$( ("$FFMPEG" -hide_banner -i "$video" 2>&1 || true) | sed -n 's/.*Duration: \([0-9:.]*\).*/\1/p' | head -1 | awk -F: '{print $1*3600+$2*60+$3}')
[[ -n "$dur" ]] || { echo "could not read the video length" >&2; exit 1; }

inputs=(-i "$video"); filters=(); labels=""; i=1
for t in "${tracks[@]}"; do
  file="${t%@*}"; spec=""; [[ "$t" == *@* ]] && spec="${t##*@}"
  IFS=: read -r start vol fd <<<"$spec"; start="${start:-0}"; vol="${vol:-$volume}"; fd="${fd:-$fade}"
  fout=$(awk -v d="$dur" -v f="$fd" 'BEGIN{s=d-f; if(s<0)s=0; print s}')
  [[ -f "$file" ]] || { echo "no such audio file: $file" >&2; exit 1; }
  ms=$(awk -v s="$start" 'BEGIN{printf "%d", s*1000}')
  inputs+=(-i "$file")
  filters+=("[$i:a]adelay=${ms}:all=1,afade=t=in:st=${start}:d=${fd},afade=t=out:st=${fout}:d=${fd},volume=${vol}[a$i]")
  labels+="[a$i]"; i=$((i+1))
done
filters+=("${labels}amix=inputs=$((i-1)):normalize=0:duration=longest[mix]")

"$FFMPEG" -hide_banner -loglevel error -y "${inputs[@]}" \
  -filter_complex "$(IFS=';'; echo "${filters[*]}")" \
  -map 0:v -map "[mix]" -c:v copy -c:a libopus -b:a "${AUDIO_BITRATE:-128k}" -t "$dur" "$out"
echo "wrote $out (${dur}s, ${#tracks[@]} track(s))"
