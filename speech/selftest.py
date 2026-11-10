"""
Самоперевірка мовного сервісу без мікрофона й без звуку: Piper синтезує фразу в пам'ять,
Whisper її розпізнає. Показує, що обидві моделі завантажуються й працюють, і скільки це триває.

Запуск:  python speech\\selftest.py
"""
import difflib
import os
import sys
import time

os.environ.setdefault("OFFGRID_SPEECH_TOKEN", "selftest")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

t0 = time.perf_counter()
import numpy as np  # noqa: E402
import speech_server as s  # noqa: E402  (завантажує обидві моделі)

print(f"Моделі завантажено за {time.perf_counter() - t0:.1f} с")

PHRASES = ["відкрий блокнот", "скільки вільного місця на диску", "запиши нотатку купити молоко і хліб"]
ok = True
for phrase in PHRASES:
    t = time.perf_counter()
    chunks = list(s.voice.synthesize(phrase, syn_config=s.syn_config))
    tts_s = time.perf_counter() - t
    audio = np.concatenate([np.asarray(c.audio_float_array, dtype=np.float32) for c in chunks])
    rate = chunks[0].sample_rate
    # перетворюємо частоту голосу Piper у 16 кГц, яких очікує Whisper
    n = int(len(audio) * s.SAMPLE_RATE / rate)
    audio16 = np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio).astype(np.float32)
    t = time.perf_counter()
    quick = s.transcribe(audio16, quick=True)
    quick_s = time.perf_counter() - t
    t = time.perf_counter()
    text = s.transcribe(audio16)
    stt_s = time.perf_counter() - t
    # синтетичний голос щоразу звучить трохи інакше, тож порівнюємо на схожість, а не на точний збіг
    clean = "".join(ch for ch in text.lower() if ch.isalpha() or ch == " ")
    ok = ok and difflib.SequenceMatcher(None, phrase, clean).ratio() >= 0.8
    print(f"«{phrase}» -> «{text}»  (звук {len(audio) / rate:.1f} с, синтез {tts_s:.2f} с, "
          f"розпізнавання {stt_s:.2f} с, проміжне {quick_s:.2f} с: «{quick}»)")

print("УСПІХ" if ok else "ПРОВАЛ: розпізнаний текст не схожий на сказаний")
sys.exit(0 if ok else 1)
