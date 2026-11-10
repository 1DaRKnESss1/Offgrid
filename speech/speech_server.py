"""
Мовний сервіс Offgrid: мікрофон -> текст (Whisper) і текст -> голос (Piper).
Працює лише на цьому комп'ютері, на процесорі, без звернень у мережу.

Запускає його сам застосунок (src/speech/client.js) і передає налаштування змінними середовища:
  OFFGRID_SPEECH_PORT, OFFGRID_SPEECH_TOKEN, OFFGRID_WHISPER_MODEL, OFFGRID_WHISPER_LIVE_MODEL,
  OFFGRID_WHISPER_DIR, OFFGRID_PIPER_VOICE, OFFGRID_SPEECH_SPEED

Дві моделі Whisper. На процесорі точна модель розпізнає фразу кілька секунд — для тексту «наживо»
це надто довго. Тому під час запису працює мала швидка модель (чернетка, може помилятись),
а остаточний текст після паузи дає точна.

Адреса: http://127.0.0.1:<порт>. Кожен запит має містити заголовок X-Offgrid-Token —
без нього сервіс не відповідає (щоб відкрита в браузері сторінка не могла ним керувати).
  GET  /health  -> стан сервісу
  POST /listen  -> слухає мікрофон; відповідь — потік рядків JSON:
                   {"type":"listening"} {"type":"speech"} {"type":"partial","text":..} ...
                   {"type":"recognizing"} {"type":"final","text":..}
  POST /stop    -> закінчити запис зараз і розпізнати те, що встигли сказати
  POST /cancel  -> скасувати запис без розпізнавання і зупинити озвучення
  POST /speak   -> тіло {"text": "..."}; озвучує, повертає {"ok":true,"first_audio_s":..,"audio_s":..,"interrupted":..}
"""
import hmac
import json
import os
import sys
import threading
import time
import types
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# Жодних звернень до Hugging Face: моделі вже лежать на диску
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

import numpy as np
import sounddevice as sd

# Бібліотека av (PyAV) потрібна faster-whisper лише для читання аудіофайлів, а ми передаємо звук масивом numpy.
# Якщо Windows (Smart App Control) блокує її DLL, підставляємо порожню заглушку.
try:
    import av  # noqa: F401
except ImportError:
    sys.modules["av"] = types.ModuleType("av")

from faster_whisper import WhisperModel
from piper import PiperVoice
from piper.config import PhonemeType, SynthesisConfig

# ---------- Налаштування ----------
HOST = "127.0.0.1"
PORT = int(os.environ.get("OFFGRID_SPEECH_PORT", "0"))  # 0 — система сама дасть вільний порт
TOKEN = os.environ.get("OFFGRID_SPEECH_TOKEN", "")
WHISPER_MODEL = os.environ.get("OFFGRID_WHISPER_MODEL", "medium")          # остаточний текст
WHISPER_LIVE_MODEL = os.environ.get("OFFGRID_WHISPER_LIVE_MODEL", "small")  # чернетка наживо; "" — вимкнути
WHISPER_DIR = os.environ.get("OFFGRID_WHISPER_DIR", r"E:\AI\whisper")
PIPER_VOICE = Path(os.environ.get("OFFGRID_PIPER_VOICE", r"E:\AI\piper\uk_UA-mykyta-high.onnx"))
SPEECH_SPEED = float(os.environ.get("OFFGRID_SPEECH_SPEED", "1.0"))  # >1 — повільніше, <1 — швидше

SAMPLE_RATE = 16000        # Whisper очікує 16 кГц, моно
BLOCK_S = 0.03             # аналізуємо звук шматками по 30 мс
PRE_ROLL_S = 0.4           # скільки звуку ДО спрацювання зберігати, щоб не обрізати перше слово
SILENCE_TO_STOP_S = 1.4    # стільки тиші після мови = кінець фрази
MAX_RECORD_S = 20          # максимальна довжина фрази
WAIT_FOR_SPEECH_S = 8      # якщо стільки мовчиш — повертаємо порожній текст
MIN_THRESHOLD = 0.01       # мінімальний поріг гучності (RMS)
MAX_THRESHOLD = 0.04       # вище не піднімаємо: інакше після шумного старту асистент «оглухне»
PARTIAL_EVERY_S = 0.8      # як часто оновлювати проміжний текст
MAX_SPEAK_CHARS = 1500
BLOCK = int(SAMPLE_RATE * BLOCK_S)

# Підказка для Whisper: слова, які часто звучать у командах
INITIAL_PROMPT = ("Команди голосовому асистенту: відкрий, закрий, знайди файл, блокнот, калькулятор, "
                  "Провідник, гучніше, тихіше, вимкни звук, котра година, документи, завантаження, нотатка.")


def log(msg):
    print(msg, flush=True)


if not TOKEN:
    sys.exit("Не задано OFFGRID_SPEECH_TOKEN: сервіс запускається лише застосунком Offgrid")

# ---------- Моделі (один раз при старті) ----------
t0 = time.perf_counter()
CPU_THREADS = max(4, (os.cpu_count() or 8) // 2)
whisper = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8", cpu_threads=CPU_THREADS,
                       download_root=WHISPER_DIR, local_files_only=True)
log(f"Whisper '{WHISPER_MODEL}' завантажено за {time.perf_counter() - t0:.1f} с (потоків: {CPU_THREADS})")
whisper_live = None
if WHISPER_LIVE_MODEL and WHISPER_LIVE_MODEL != WHISPER_MODEL:
    try:
        whisper_live = WhisperModel(WHISPER_LIVE_MODEL, device="cpu", compute_type="int8", cpu_threads=CPU_THREADS,
                                    download_root=WHISPER_DIR, local_files_only=True)
        log(f"Whisper '{WHISPER_LIVE_MODEL}' (чернетка наживо) завантажено")
    except Exception as e:  # noqa: BLE001 — без чернетки сервіс усе одно працює
        log(f"Модель для тексту наживо '{WHISPER_LIVE_MODEL}' недоступна: {e}")

if not PIPER_VOICE.exists():
    sys.exit(f"Не знайдено голос Piper: {PIPER_VOICE}")
voice = PiperVoice.load(PIPER_VOICE)
syn_config = SynthesisConfig(length_scale=SPEECH_SPEED)
# Голос типу "text" знає лише малі літери: велика просто викидається
LOWERCASE_TEXT = voice.config.phoneme_type == PhonemeType.TEXT
log(f"Голос Piper '{PIPER_VOICE.stem}' завантажено")

WHISPER_LOCK = threading.Lock()   # одну модель Whisper не можна викликати з двох потоків одночасно
LIVE_LOCK = threading.Lock()
LISTEN_LOCK = threading.Lock()    # один запис за раз
SPEAK_LOCK = threading.Lock()     # одне озвучення за раз
STOP_LISTEN = threading.Event()   # «закінчити запис і розпізнати»
CANCEL_LISTEN = threading.Event() # «скасувати запис»
CANCEL_SPEAK = threading.Event()  # «замовкнути»

# ---------- Мікрофон ----------
THRESHOLD = MIN_THRESHOLD
MIC_ERROR = None


def set_threshold(levels):
    """Поріг мови = утричі вище за фоновий шум. Шум беремо як тихіші 20% виміряних відрізків,
    тож окремі гучні звуки (музика, голос) його не завищують; до того ж поріг обмежено зверху."""
    global THRESHOLD
    if len(levels) >= 10:
        THRESHOLD = min(MAX_THRESHOLD, max(MIN_THRESHOLD, float(np.percentile(levels, 20)) * 3))


def calibrate():
    """Міряє фоновий шум 1 секунду і виставляє поріг, з якого звук вважається мовою."""
    global MIC_ERROR
    try:
        with sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="float32", blocksize=BLOCK) as s:
            noise = [float(np.sqrt(np.mean(s.read(BLOCK)[0] ** 2))) for _ in range(int(1 / BLOCK_S))]
        set_threshold(noise)
        MIC_ERROR = None
        log(f"Мікрофон відкалібровано, поріг гучності {THRESHOLD:.4f}")
    except Exception as e:  # noqa: BLE001
        MIC_ERROR = f"Мікрофон недоступний: {e}"
        log(MIC_ERROR)


def transcribe(audio, quick=False):
    """quick=True — чернетка малою моделлю (якщо вона є); інакше точний остаточний текст."""
    model, lock = (whisper_live, LIVE_LOCK) if quick and whisper_live is not None else (whisper, WHISPER_LOCK)
    with lock:
        segments, _ = model.transcribe(
            audio, language="uk", beam_size=1, vad_filter=not quick, condition_on_previous_text=False,
            initial_prompt=INITIAL_PROMPT, without_timestamps=True,
        )
        return " ".join(s.text.strip() for s in segments).strip()


def listen(emit):
    """Пише з мікрофона до паузи. emit(dict) надсилає подію клієнту. Повертає нічого: усе через emit."""
    if MIC_ERROR:
        calibrate()
        if MIC_ERROR:
            emit({"type": "error", "error": MIC_ERROR})
            return
    # Прапорці STOP/CANCEL тут НЕ скидаємо: їх ставлять лише під час запису й прибирають після нього
    # (див. _listen_stream), тож «скасувати», надіслане в першу ж мить, не загубиться.
    chunks, started, silence, waited, total = [], False, 0.0, 0.0, 0.0
    quiet_levels = []  # гучність, поки чекали на мову: з неї уточнюємо поріг
    pre_roll = deque(maxlen=int(PRE_ROLL_S / BLOCK_S))
    finished = threading.Event()   # після цього проміжні результати вже не надсилаємо
    partial_busy = threading.Event()
    last_partial = 0.0

    def partial_worker(audio):
        try:
            text = transcribe(audio, quick=True)
            if text and not finished.is_set():
                emit({"type": "partial", "text": text})
        except Exception:  # noqa: BLE001 — проміжний текст не критичний
            pass
        finally:
            partial_busy.clear()

    t_start = time.perf_counter()
    try:
        with sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="float32", blocksize=BLOCK) as stream:
            emit({"type": "listening"})
            while True:
                if CANCEL_LISTEN.is_set() or STOP_LISTEN.is_set():
                    break
                data, _ = stream.read(BLOCK)
                rms = float(np.sqrt(np.mean(data ** 2)))
                if not started:
                    waited += BLOCK_S
                    if rms > THRESHOLD:
                        started = True
                        chunks.extend(pre_roll)
                        chunks.append(data.copy())
                        emit({"type": "speech"})
                    elif waited > WAIT_FOR_SPEECH_S:
                        set_threshold(quiet_levels)  # нічого не почули — можливо, поріг застарів
                        break
                    else:
                        pre_roll.append(data.copy())
                        quiet_levels.append(rms)
                    continue
                chunks.append(data.copy())
                total += BLOCK_S
                silence = silence + BLOCK_S if rms < THRESHOLD else 0.0
                if silence >= SILENCE_TO_STOP_S or total >= MAX_RECORD_S:
                    break
                # проміжний текст: розпізнаємо все сказане досі, якщо попереднє розпізнавання вже закінчилось
                if (whisper_live is not None and total - last_partial >= PARTIAL_EVERY_S and total >= 0.6
                        and not partial_busy.is_set()):
                    last_partial = total
                    partial_busy.set()
                    threading.Thread(target=partial_worker, args=(np.concatenate(chunks).flatten(),), daemon=True).start()
    except Exception as e:  # noqa: BLE001
        finished.set()
        emit({"type": "error", "error": f"Не вдалося записати звук: {e}"})
        return

    finished.set()
    record_s = time.perf_counter() - t_start
    if CANCEL_LISTEN.is_set():
        emit({"type": "cancelled"})
        return
    if not chunks:
        emit({"type": "final", "text": "", "record_s": record_s, "stt_s": 0})
        return
    emit({"type": "recognizing"})
    t1 = time.perf_counter()
    try:
        text = transcribe(np.concatenate(chunks).flatten())
    except Exception as e:  # noqa: BLE001
        emit({"type": "error", "error": f"Не вдалося розпізнати мову: {e}"})
        return
    if CANCEL_LISTEN.is_set():
        emit({"type": "cancelled"})
        return
    emit({"type": "final", "text": text, "record_s": record_s, "stt_s": time.perf_counter() - t1})


def speak(text):
    """Озвучує текст по реченнях: звук починається, щойно готове перше. Повертає (first_audio_s, audio_s, interrupted)."""
    if LOWERCASE_TEXT:
        text = text.lower()
    t = time.perf_counter()
    first_audio_s, audio_s, stream = None, 0.0, None
    try:
        for chunk in voice.synthesize(text, syn_config=syn_config):
            if CANCEL_SPEAK.is_set():
                break
            audio = np.asarray(chunk.audio_float_array, dtype=np.float32)
            if stream is None:
                stream = sd.OutputStream(samplerate=chunk.sample_rate, channels=1, dtype="float32")
                stream.start()
                first_audio_s = time.perf_counter() - t
            step = int(chunk.sample_rate * 0.05)  # пишемо по 50 мс, щоб швидко реагувати на «замовкни»
            for i in range(0, len(audio), step):
                if CANCEL_SPEAK.is_set():
                    break
                stream.write(audio[i:i + step].reshape(-1, 1))
            audio_s += len(audio) / chunk.sample_rate
    finally:
        if stream is not None:
            if CANCEL_SPEAK.is_set():
                stream.abort()
            else:
                stream.stop()
            stream.close()
    return first_audio_s or 0.0, audio_s, CANCEL_SPEAK.is_set()


class Handler(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self):
        got = self.headers.get("X-Offgrid-Token", "")
        if hmac.compare_digest(got.encode("utf-8"), TOKEN.encode("utf-8")):
            return True
        self._json(403, {"ok": False, "error": "forbidden"})
        return False

    def do_GET(self):
        if not self._authorized():
            return
        if self.path == "/health":
            self._json(200, {"ok": True, "whisper": WHISPER_MODEL, "live": WHISPER_LIVE_MODEL if whisper_live else None,
                             "voice": PIPER_VOICE.stem, "mic_error": MIC_ERROR})
        else:
            self._json(404, {"ok": False, "error": "not found"})

    def _listen_stream(self):
        if not LISTEN_LOCK.acquire(blocking=False):
            return self._json(409, {"ok": False, "error": "Я вже слухаю"})
        try:
            # слухати й говорити одночасно не можна: інакше асистент запише власний голос як команду
            if SPEAK_LOCK.locked():
                CANCEL_SPEAK.set()
                for _ in range(40):
                    if not SPEAK_LOCK.locked():
                        break
                    time.sleep(0.05)
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            write_lock = threading.Lock()

            def emit(event):
                line = (json.dumps(event, ensure_ascii=False) + "\n").encode("utf-8")
                with write_lock:
                    try:
                        self.wfile.write(line)
                        self.wfile.flush()
                    except OSError:
                        CANCEL_LISTEN.set()  # клієнт від'єднався — запис більше нікому не потрібен

            listen(emit)
        finally:
            STOP_LISTEN.clear()
            CANCEL_LISTEN.clear()
            LISTEN_LOCK.release()
            self.close_connection = True

    def do_POST(self):
        if not self._authorized():
            return
        try:
            if self.path == "/listen":
                self._listen_stream()
            elif self.path == "/stop":
                if LISTEN_LOCK.locked():  # поза записом прапорець не ставимо, щоб не зачепити наступний
                    STOP_LISTEN.set()
                self._json(200, {"ok": True})
            elif self.path == "/cancel":
                if LISTEN_LOCK.locked():
                    CANCEL_LISTEN.set()
                if SPEAK_LOCK.locked():
                    CANCEL_SPEAK.set()
                self._json(200, {"ok": True})
            elif self.path == "/speak":
                length = min(int(self.headers.get("Content-Length", 0)), 64 * 1024)
                text = str(json.loads(self.rfile.read(length) or b"{}").get("text", "")).strip()[:MAX_SPEAK_CHARS]
                if not text:
                    return self._json(200, {"ok": True, "first_audio_s": 0, "audio_s": 0, "interrupted": False})
                if not SPEAK_LOCK.acquire(blocking=False):
                    return self._json(409, {"ok": False, "error": "Я ще говорю"})
                try:
                    first_audio_s, audio_s, interrupted = speak(text)
                finally:
                    CANCEL_SPEAK.clear()
                    SPEAK_LOCK.release()
                self._json(200, {"ok": True, "first_audio_s": first_audio_s, "audio_s": audio_s, "interrupted": interrupted})
            else:
                self._json(404, {"ok": False, "error": "not found"})
        # одна збійна команда не має валити весь сервіс: клієнт отримає текст помилки
        except Exception as e:  # noqa: BLE001
            try:
                self._json(500, {"ok": False, "error": str(e)})
            except OSError:
                pass

    def log_message(self, format, *args):  # noqa: A002 — ім'я параметра як у базовому класі
        """Не засмічуємо вивід записом кожного запиту."""


class Server(ThreadingHTTPServer):
    daemon_threads = True
    # На Windows «повторне використання адреси» дозволило б іншій програмі сісти на той самий порт
    allow_reuse_address = False


def exit_with_parent():
    """Застосунок тримає наш stdin відкритим. Коли він закривається (навіть аварійно) — виходимо й ми."""
    try:
        sys.stdin.buffer.read()
    except Exception:  # noqa: BLE001
        pass
    os._exit(0)


if __name__ == "__main__":
    server = Server((HOST, PORT), Handler)
    threading.Thread(target=exit_with_parent, daemon=True).start()
    threading.Thread(target=calibrate, daemon=True).start()
    log(f"READY http://{HOST}:{server.server_address[1]}")
    server.serve_forever()
