"""Cut a short breath from the speaker's own sample, deterministically (for subtle paralinguistics in the narration).

  venv/bin/python packages/tools/media/extract_breath.py SAMPLE.wav [--out-dir DIR]

Silero VAD (MIT) finds the pauses between phrases; in each pause, the 220 ms just before the next phrase starts is scored by
noisiness (spectral flatness) and level; the best one that is quiet enough not to be speech but clearly above the noise floor
is written to DIR/breath.wav (default ~/.cache/construct-media/para, OUTSIDE the repo) and printed as JSON. Prints
{"path": null} when the sample has no usable breath. The sample is only read; nothing is downloaded.
"""
import argparse, json, os, warnings
warnings.filterwarnings("ignore")
import numpy as np, librosa, soundfile as sf, torch
from silero_vad import load_silero_vad, get_speech_timestamps

ap = argparse.ArgumentParser(); ap.add_argument("sample"); ap.add_argument("--out-dir", default=os.path.expanduser("~/.cache/construct-media/para"))
a = ap.parse_args()
os.makedirs(a.out_dir, exist_ok=True)
y, sr = librosa.load(a.sample, sr=None, mono=True)
y16 = librosa.resample(y, orig_sr=sr, target_sr=16000)
segs = [(s["start"] / 16000, s["end"] / 16000) for s in get_speech_timestamps(torch.from_numpy(y16), load_silero_vad(), sampling_rate=16000, speech_pad_ms=0)]
noise_floor = np.percentile(librosa.amplitude_to_db(librosa.feature.rms(y=y)[0] + 1e-9), 5)
best = None
for (s0, e0), (s1, e1) in zip(segs, segs[1:]):
    if s1 - e0 < 0.3:
        continue
    w1 = s1 - 0.03; w0 = w1 - 0.22
    if w0 < e0 + 0.02:
        continue
    w = y[int(w0 * sr): int(w1 * sr)]
    db = float(librosa.amplitude_to_db(np.array([np.sqrt(np.mean(w ** 2))]) + 1e-9)[0])
    flat = float(np.mean(librosa.feature.spectral_flatness(y=w, n_fft=1024)))
    if db < noise_floor + 8 or db > -28:
        continue
    score = flat
    if best is None or score > best[0]:
        best = (score, w0, w1, db, flat)
if best is None or best[4] < 0.05:
    print(json.dumps({"path": None, "reason": "no breath-like pause in the sample"}))
else:
    _, w0, w1, db, flat = best
    path = os.path.join(a.out_dir, "breath.wav")
    w = y[int(w0 * sr): int(w1 * sr)]
    w = w * (10 ** (-20 / 20) / (np.sqrt(np.mean(w ** 2)) + 1e-9))  # RMS -20 dBFS, like speech; the mix lowers it again
    sf.write(path, np.clip(w, -0.99, 0.99), sr)
    print(json.dumps({"path": path, "start": round(w0, 2), "end": round(w1, 2), "level_db": round(db, 1), "flatness": round(flat, 3)}))
