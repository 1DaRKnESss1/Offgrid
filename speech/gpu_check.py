"""
Перевірка: чи працює розпізнавання мови (Whisper) на відеокарті і наскільки воно швидше.
Звуку не відтворює й мікрофон не чіпає: фрази синтезує Piper у пам'ять.

Запуск:  python speech\\gpu_check.py [модель ...]     (типово: large-v3-turbo medium)
Потрібні бібліотеки NVIDIA в speech\\vendor (див. README, розділ про відеокарту).
"""
import difflib
import os
import subprocess
import sys
import time
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
os.environ["HF_HUB_OFFLINE"] = "1"

# Бібліотеки NVIDIA лежать у папці проєкту, а не в системі — показуємо, де їх шукати
for sub in ("cublas", "cudnn", "cuda_nvrtc"):
    d = HERE / "vendor" / "nvidia" / sub / "bin"
    if d.is_dir():
        os.add_dll_directory(str(d))
        os.environ["PATH"] = str(d) + os.pathsep + os.environ.get("PATH", "")

try:
    import av  # noqa: F401
except ImportError:
    sys.modules["av"] = types.ModuleType("av")

import numpy as np
from faster_whisper import WhisperModel
from piper import PiperVoice

WHISPER_DIR = os.environ.get("OFFGRID_WHISPER_DIR", r"E:\AI\whisper")
VOICE = os.environ.get("OFFGRID_PIPER_VOICE", r"E:\AI\piper\uk_UA-ukrainian_tts-medium.onnx")
PHRASES = ["відкрий блокнот", "скільки вільного місця на диску", "запиши нотатку купити молоко і хліб",
           "знайди в інтернеті погоду в харкові на завтра"]


def vram_mb():
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=5).stdout
        return int(out.strip().splitlines()[0])
    except Exception:  # noqa: BLE001
        return -1


voice = PiperVoice.load(VOICE)
clips = []
for phrase in PHRASES:
    chunks = list(voice.synthesize(phrase))
    audio = np.concatenate([np.asarray(c.audio_float_array, dtype=np.float32) for c in chunks])
    n = int(len(audio) * 16000 / chunks[0].sample_rate)
    clips.append(np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio).astype(np.float32))

models = sys.argv[1:] or ["large-v3-turbo", "medium"]
for name in models:
    for compute in ("int8_float16", "float16"):
        before = vram_mb()
        try:
            t = time.perf_counter()
            model = WhisperModel(name, device="cuda", compute_type=compute, download_root=WHISPER_DIR, local_files_only=True)
            load_s = time.perf_counter() - t
            list(model.transcribe(clips[0], language="uk", beam_size=1)[0])  # прогрів
            times, score = [], []
            for phrase, clip in zip(PHRASES, clips):
                t = time.perf_counter()
                segments, _ = model.transcribe(clip, language="uk", beam_size=1, vad_filter=True,
                                               condition_on_previous_text=False, without_timestamps=True)
                text = " ".join(s.text.strip() for s in segments).strip()
                times.append(time.perf_counter() - t)
                clean = "".join(ch for ch in text.lower() if ch.isalpha() or ch == " ")
                score.append(difflib.SequenceMatcher(None, phrase, clean).ratio())
            print(f"{name:15} {compute:13} завантаження {load_s:4.1f} с | фраза {min(times):.2f}–{max(times):.2f} с | "
                  f"схожість {min(score):.2f}–{max(score):.2f} | відеопам'ять +{vram_mb() - before} МБ", flush=True)
            del model
        except Exception as e:  # noqa: BLE001
            print(f"{name:15} {compute:13} НЕ ПРАЦЮЄ: {str(e)[:160]}", flush=True)
        time.sleep(1)
