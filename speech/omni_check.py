"""
Перевірка голосу OmniVoice: завантажує модель, генерує зразки у WAV-файли (без відтворення)
і міряє, скільки відеопам'яті вона займає та як швидко синтезує.

Запуск (із середовища speech\\tts-env):
  speech\\tts-env\\Scripts\\python.exe speech\\omni_check.py [кількість кроків, типово 16]
Зразки кладе в data\\voice-samples.
"""
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault("HF_HOME", r"E:\AI\omnivoice")          # модель лежить поруч з іншими моделями
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

import numpy as np
import soundfile as sf
import torch
from omnivoice import OmniVoice
from omnivoice.models.omnivoice import OmniVoiceGenerationConfig

OUT = ROOT / "data" / "voice-samples"
OUT.mkdir(parents=True, exist_ok=True)
STEPS = int(sys.argv[1]) if len(sys.argv) > 1 else 16
INSTRUCT = os.environ.get("OFFGRID_VOICE_INSTRUCT", "male, young adult, very low pitch")
SPEED = float(os.environ.get("OFFGRID_VOICE_SPEED", "1.1"))
PHRASES = {
    "short": "Блокнот відкрито, можеш писати.",
    "numbers": "Зараз 22:31, четвер, 12 листопада. На диску вільно близько 220 гігабайт.",
    "long": ("Веселка з'являється тоді, коли сонячне світло проходить крізь краплі дощу й розкладається на кольори, "
             "наче в призмі. Саме тому її видно лише тоді, коли сонце світить у тебе за спиною, а дощ іде попереду."),
    "question": "Знайшов два файли зі звітом. Який із них відкрити — за жовтень чи за листопад?",
}


def vram_mb():
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=5).stdout
        return int(out.strip().splitlines()[0])
    except Exception:  # noqa: BLE001
        return -1


before = vram_mb()
t = time.perf_counter()
model = OmniVoice.from_pretrained("k2-fsa/OmniVoice", device_map="cuda:0", dtype=torch.float16)
print(f"Модель завантажено за {time.perf_counter() - t:.1f} с; відеопам'ять +{vram_mb() - before} МБ", flush=True)

config = OmniVoiceGenerationConfig(num_step=STEPS)
# прогрів: перша генерація на відеокарті завжди найдовша
model.generate(text="Привіт.", language="Ukrainian", instruct=INSTRUCT, speed=SPEED, generation_config=config)
print(f"Після прогріву відеопам'ять +{vram_mb() - before} МБ; кроків: {STEPS}; голос: {INSTRUCT}; темп: {SPEED}", flush=True)

for name, text in PHRASES.items():
    t = time.perf_counter()
    audio = model.generate(text=text, language="Ukrainian", instruct=INSTRUCT, speed=SPEED, generation_config=config)[0]
    took = time.perf_counter() - t
    seconds = len(audio) / 24000
    sf.write(str(OUT / f"omnivoice-{name}-steps{STEPS}.wav"), np.asarray(audio), 24000)
    print(f"{name:9} звук {seconds:5.1f} с, синтез {took:5.2f} с (у {seconds / took:4.1f} раза швидше за мовлення)", flush=True)

print(f"Пік відеопам'яті PyTorch: {torch.cuda.max_memory_allocated() / 1048576:.0f} МБ; зараз зайнято всього: {vram_mb()} МБ", flush=True)
