"""Objective scores for generated narration clips, no listening needed.

  venv/bin/python packages/packages/tools/media/eval_voice.py SAMPLE.wav ITEMS.json

ITEMS.json is [{ id, wav, text }]. Prints JSON { reference, items: [{ id, similarity, wer, f0std }] }:
  similarity  cosine of Resemblyzer speaker embeddings (Apache-2.0, code and weights) clip vs the real sample's speech
  wer         word error rate of faster-whisper base.en (MIT) against the spoken text (a round trip through speech-to-text)
  f0std       standard deviation of pitch in semitones (librosa pyin), the expression proxy; `reference.f0std` is the real sample's
The sample and clips are only read.
"""
import json, re, sys, warnings
warnings.filterwarnings("ignore")
import types
sys.modules.setdefault("webrtcvad", types.ModuleType("webrtcvad"))  # resemblyzer imports it only for its own VAD, which we replace with silero
import numpy as np, librosa, torch
from resemblyzer import VoiceEncoder
from faster_whisper import WhisperModel
from silero_vad import load_silero_vad, get_speech_timestamps

sample, items_file = sys.argv[1:3]
items = json.load(open(items_file))
enc = VoiceEncoder("cpu", verbose=False)
asr = WhisperModel("base.en", device="cpu", compute_type="int8")


def speech_only(y16):
    segs = get_speech_timestamps(torch.from_numpy(y16), load_silero_vad(), sampling_rate=16000)
    return np.concatenate([y16[s["start"]: s["end"]] for s in segs]) if segs else y16


def f0std(y, sr):
    f0, voiced, _ = librosa.pyin(y, fmin=70, fmax=400, sr=sr, frame_length=2048, hop_length=512)
    v = voiced & np.isfinite(f0)
    return float(np.std(12 * np.log2(f0[v] / np.median(f0[v])))) if v.sum() > 20 else 0.0


def words(t):
    return re.findall(r"[a-z0-9']+", t.lower().replace("-", " "))


def wer(ref, hyp):
    d = list(range(len(hyp) + 1))
    for i, a in enumerate(ref, 1):
        p = d[:]; d[0] = i
        for j, b in enumerate(hyp, 1):
            d[j] = min(p[j] + 1, d[j - 1] + 1, p[j - 1] + (a != b))
    return d[len(hyp)]


y, sr = librosa.load(sample, sr=None, mono=True)
y16 = librosa.resample(y, orig_sr=sr, target_sr=16000)
ref_emb = enc.embed_utterance(speech_only(y16))
out = []
for it in items:
    c, csr = librosa.load(it["wav"], sr=None, mono=True)
    c16 = librosa.resample(c, orig_sr=csr, target_sr=16000)
    emb = enc.embed_utterance(c16)
    segs, _ = asr.transcribe(it["wav"], language="en")
    hyp = words(" ".join(x.text for x in segs))
    r = words(it["text"])
    out.append({"id": it["id"], "similarity": round(float(np.dot(emb, ref_emb) / (np.linalg.norm(emb) * np.linalg.norm(ref_emb))), 4),
                "wer_words": len(r), "wer_errors": wer(r, hyp), "f0std": round(f0std(c, csr), 2)})
print(json.dumps({"reference": {"f0std": round(f0std(y, sr), 2)}, "items": out}))
