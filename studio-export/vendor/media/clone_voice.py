"""Speak lines in the voice of a sample its speaker supplied (Chatterbox, MIT code and weights, CPU).

  ~/.cache/construct-media/venv/bin/python packages/packages/tools/media/clone_voice.py SAMPLE.wav JOB.json OUT_DIR

JOB.json is a list of { text, file, exaggeration?, cfg_weight?, temperature?, pause_ms?, seed?, ref?, model? } (model "turbo" for Chatterbox-Turbo). Writes
OUT_DIR/<file>.wav per entry and prints one JSON line per clip. Called by synth.mjs (script.mjs, voiceover.mjs).
Each line is split into sentences, spoken one by one (the model drifts on long generations), joined with a pause of
pause_ms (default 280) between sentences, trimmed of leading and trailing silence and levelled to -20 LUFS, so every line
has the same loudness. `ref` (a wav path) overrides SAMPLE.wav for one entry. The sample is read where it is; nothing
derived from it is written (the model keeps the voice conditioning in memory only). Every clip carries Chatterbox's
inaudible Perth watermark marking it as synthetic.
"""
import json, os, re, sys, time, zlib
os.environ.setdefault("TQDM_DISABLE", "1")
import numpy as np, torch, torchaudio, librosa, pyloudnorm

sample, job_file, out_dir = sys.argv[1:4]
torch.set_num_threads(max(1, (os.cpu_count() or 4) - 2))

TARGET_LUFS = -20.0
JOB = json.load(open(job_file))
TURBO = bool(JOB) and JOB[0].get("model") == "turbo"  # Chatterbox-Turbo (MIT, ~350M, paralinguistic tags such as [chuckle])
if TURBO:
    from chatterbox.tts_turbo import ChatterboxTurboTTS as Model
else:
    from chatterbox.tts import ChatterboxTTS as Model
model = Model.from_pretrained(device="cpu")
current_ref = None


def use_ref(path):
    global current_ref
    if path != current_ref:
        model.prepare_conditionals(path, exaggeration=0.5)  # in memory only
        current_ref = path


def sentences(text):
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    return [p for p in parts if p]


def trim(y, sr):
    yt, idx = librosa.effects.trim(y, top_db=38)
    keep = int(0.03 * sr)
    return y[max(0, idx[0] - keep): min(len(y), idx[1] + keep)]


os.makedirs(out_dir, exist_ok=True)
for i, c in enumerate(JOB):
    t = time.time()
    use_ref(c.get("ref") or sample)
    kw = {k: c[k] for k in (("temperature",) if TURBO else ("exaggeration", "cfg_weight", "temperature")) if k in c}
    seed = int(c.get("seed", 1)) + zlib.crc32(c["text"].encode()) % 100000  # same text, same take
    pieces = []
    gap = np.zeros(int(model.sr * float(c.get("pause_ms", 280)) / 1000), dtype=np.float32)
    for n, s in enumerate(sentences(c["text"])):
        torch.manual_seed(seed + n)
        y = trim(model.generate(s, **kw).squeeze(0).numpy(), model.sr)
        if pieces:
            pieces.append(gap)
        pieces.append(y)
    y = np.concatenate(pieces)
    loud = pyloudnorm.Meter(model.sr).integrated_loudness(y)
    y = pyloudnorm.normalize.loudness(y, loud, TARGET_LUFS) if np.isfinite(loud) else y
    y = np.clip(y, -0.99, 0.99).astype(np.float32)
    path = os.path.join(out_dir, f"{c.get('file', f'c{i}')}.wav")
    torchaudio.save(path, torch.from_numpy(y).unsqueeze(0), model.sr)
    print(json.dumps({"i": i, "path": path, "seconds": len(y) / model.sr, "compute": round(time.time() - t, 1)}), flush=True)
