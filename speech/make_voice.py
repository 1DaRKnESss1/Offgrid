"""
Створює постійний «відбиток» голосу для OmniVoice із короткого зразка — щоб асистент завжди звучав однаково.

Запуск (із середовища speech\\tts-env):
  speech\\tts-env\\Scripts\\python.exe speech\\make_voice.py <зразок.wav> "<точний текст зразка>" [куди зберегти.pt]

Зразок: 3–10 секунд чистого мовлення українською (довший сповільнює синтез і може погіршити якість).
Використовуй лише власний голос, згенерований голос або голос людини, яка дала на це згоду.
Відбиток типово зберігається в data\\voice\\offgrid-voice.pt; поруч кладуться зразки для прослуховування.
"""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault("HF_HOME", r"E:\AI\omnivoice")
os.environ.setdefault("HF_HUB_OFFLINE", "1")

if len(sys.argv) < 3:
    sys.exit(__doc__)
ref_audio, ref_text = sys.argv[1], sys.argv[2]
out = Path(sys.argv[3]) if len(sys.argv) > 3 else ROOT / "data" / "voice" / "offgrid-voice.pt"
if not Path(ref_audio).is_file():
    sys.exit(f"Не знайдено зразок: {ref_audio}")

import numpy as np
import soundfile as sf
import torch
from omnivoice import OmniVoice
from omnivoice.models.omnivoice import OmniVoiceGenerationConfig

model = OmniVoice.from_pretrained("k2-fsa/OmniVoice", device_map="cuda:0" if torch.cuda.is_available() else "cpu",
                                  dtype=torch.float16 if torch.cuda.is_available() else torch.float32)
prompt = model.create_voice_clone_prompt(ref_audio=ref_audio, ref_text=ref_text)
out.parent.mkdir(parents=True, exist_ok=True)
prompt.save(str(out))
print(f"Відбиток голосу збережено: {out}", flush=True)

# Кілька фраз цим голосом — послухати, чи він стабільний
samples = ROOT / "data" / "voice-samples"
samples.mkdir(parents=True, exist_ok=True)
config = OmniVoiceGenerationConfig(num_step=int(os.environ.get("OFFGRID_VOICE_STEPS", "16")))
speed = float(os.environ.get("OFFGRID_VOICE_SPEED", "1.1"))
phrases = {
    "1-short": "Блокнот відкрито, можеш писати.",
    "2-numbers": "Зараз 22:31, четвер, 12 листопада. На диску вільно близько 220 гігабайт.",
    "3-long": ("Веселка з'являється тоді, коли сонячне світло проходить крізь краплі дощу й розкладається на кольори, "
               "наче в призмі. Саме тому її видно лише тоді, коли сонце світить у тебе за спиною, а дощ іде попереду."),
    "4-words": "Щоб перезавантажити комп'ютер, збережи незбережені документи, зокрема той, що в папці «Завантаження».",
    "5-english": "Відкриваю YouTube у браузері Chrome. Файл називається report final, його розмір 3,5 мегабайта.",
}
for name, text in phrases.items():
    audio = model.generate(text=text, language="Ukrainian", voice_clone_prompt=prompt, speed=speed, generation_config=config)[0]
    sf.write(str(samples / f"voice-{name}.wav"), np.asarray(audio), 24000)
    print(f"  voice-{name}.wav  ({len(audio) / 24000:.1f} с)", flush=True)
