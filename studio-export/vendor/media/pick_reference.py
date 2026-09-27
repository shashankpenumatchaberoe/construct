"""Pick the best 10-20 s reference window of a voice sample, deterministically, or cut a chosen one.

  venv/bin/python packages/tools/media/pick_reference.py SAMPLE.wav [--min 10] [--max 20] [--top 3] [--start S --end E] [--out-dir DIR]

Speech segments come from silero-vad (MIT). Candidate windows start and end on segment edges (never mid-word), are
10-20 s long, contain no clipping, and are ranked by expressiveness (F0 spread in semitones from librosa pyin, plus loudness
dynamics of the voiced frames) minus a penalty for a high noise floor and for long silences. The excerpt is written to
DIR (default ~/.cache/construct-media/ref, OUTSIDE the repo) and its path is printed as JSON. --start/--end cut exactly
that window instead. The sample is only read.
"""
import argparse, json, os
import numpy as np, librosa, soundfile as sf, torch
from silero_vad import load_silero_vad, get_speech_timestamps

ap = argparse.ArgumentParser()
ap.add_argument("sample"); ap.add_argument("--min", type=float, default=10); ap.add_argument("--max", type=float, default=20)
ap.add_argument("--top", type=int, default=3); ap.add_argument("--start", type=float); ap.add_argument("--end", type=float)
ap.add_argument("--out-dir", default=os.path.expanduser("~/.cache/construct-media/ref"))
a = ap.parse_args()
os.makedirs(a.out_dir, exist_ok=True)
y, sr = librosa.load(a.sample, sr=None, mono=True)


def cut(s, e, tag):
    path = os.path.join(a.out_dir, f"{tag}-{s:.1f}-{e:.1f}.wav")
    sf.write(path, y[int(s * sr): int(e * sr)], sr)
    return path


if a.start is not None and a.end is not None:
    print(json.dumps({"path": cut(a.start, a.end, "manual"), "start": a.start, "end": a.end}))
    raise SystemExit

y16 = librosa.resample(y, orig_sr=sr, target_sr=16000)
segs = get_speech_timestamps(torch.from_numpy(y16), load_silero_vad(), sampling_rate=16000, min_silence_duration_ms=250, speech_pad_ms=60)
segs = [(s["start"] / 16000, s["end"] / 16000) for s in segs]
f0, voiced, _ = librosa.pyin(y, fmin=70, fmax=400, sr=sr, frame_length=2048, hop_length=512)
hop = 512 / sr
rms = librosa.amplitude_to_db(librosa.feature.rms(y=y, frame_length=2048, hop_length=512)[0] + 1e-9)
t = np.arange(len(rms)) * hop
speech_mask = np.zeros(len(rms), bool)
for s, e in segs:
    speech_mask[(t >= s) & (t <= e)] = True
cands = []
for i in range(len(segs)):
    for j in range(i, len(segs)):
        s, e = segs[i][0], segs[j][1]
        if e - s < a.min:
            continue
        if e - s > a.max:
            break
        m = (t >= s) & (t <= e)
        seg = y[int(s * sr): int(e * sr)]
        clipped = int((np.abs(seg) >= 0.99).sum())
        clip_share = clipped / max(1, len(seg))
        v = m & voiced & np.isfinite(f0)
        if v.sum() < 50:
            continue
        st = 12 * np.log2(f0[v] / np.median(f0[v]))
        f0_std = float(np.std(st))
        dyn = float(np.std(rms[m & speech_mask])) if (m & speech_mask).sum() > 10 else 0.0
        floor = float(np.percentile(rms[m], 5))
        sil = 1 - float((m & speech_mask).sum() / m.sum())
        score = f0_std + 0.15 * dyn - 0.05 * max(0.0, floor + 60) - 6 * max(0.0, sil - 0.2) - 300 * clip_share
        cands.append({"start": round(s, 2), "end": round(e, 2), "f0_std_semitones": round(f0_std, 2), "loudness_std_db": round(dyn, 2),
                      "noise_floor_db": round(floor, 1), "silence_share": round(sil, 2), "clipped_samples": clipped, "score": round(score, 3)})
cands.sort(key=lambda c: (-c["score"], c["start"]))
best = cands[: a.top]
for c in best:
    c["path"] = cut(c["start"], c["end"], "best")
print(json.dumps({"speech_segments": len(segs), "candidates": len(cands), "top": best}, indent=1))
