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
                   тіло (необов'язково) {"wait_s": 5, "strict": true}: скільки чекати на початок мови;
                   strict — початком мови вважати лише стійкий звук, а не один гучний клац
  POST /stop    -> закінчити запис зараз і розпізнати те, що встигли сказати
  POST /cancel  -> скасувати запис без розпізнавання і зупинити озвучення
  POST /say     -> тіло {"text": "речення"}; додає речення до озвучення й одразу повертається
  POST /say-done-> більше речень не буде; чекає, доки все прозвучить: {"ok":true,"interrupted":..,"audio_s":..}
  POST /speak   -> те саме, що /say і /say-done разом (один текст цілком)
  POST /wake    -> повернути модель розпізнавання на відеокарту заздалегідь (у фоні)
  POST /sleep   -> звільнити відеопам'ять: модель розпізнавання вивантажується з відеокарти.
                   Повертається сама, щойно почнеться наступний запис (близько 2 с, у фоні)

Відеокарта. Якщо в speech\vendor лежать бібліотеки NVIDIA (cuBLAS, cuDNN) і відеокарта доступна, розпізнавання
працює на ній: одна модель (OFFGRID_WHISPER_GPU_MODEL, типово large-v3-turbo) дає і текст наживо, і остаточний
приблизно за 0,2 с замість 3 с, займаючи близько 1,2 ГБ відеопам'яті. OFFGRID_WHISPER_DEVICE=cpu це вимикає;
якщо модель на відеокарті не завантажилась, сервіс сам переходить на процесор.

Швидкість на процесорі. Точне розпізнавання починається ще під час короткої паузи в мовленні («наперед»): якщо людина
після паузи не продовжила, результат готовий приблизно на секунду раніше. Для цього точна модель
завантажується у двох примірниках (OFFGRID_WHISPER_AHEAD=0 це вимикає й заощаджує близько 1 ГБ пам'яті).
"""
import hmac
import json
import os
import queue
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

sys.path.insert(0, str(Path(__file__).resolve().parent))
from speaker import Speaker  # noqa: E402

# ---------- Налаштування ----------
HOST = "127.0.0.1"
PORT = int(os.environ.get("OFFGRID_SPEECH_PORT", "0"))  # 0 — система сама дасть вільний порт
TOKEN = os.environ.get("OFFGRID_SPEECH_TOKEN", "")
WHISPER_MODEL = os.environ.get("OFFGRID_WHISPER_MODEL", "medium")          # остаточний текст
WHISPER_LIVE_MODEL = os.environ.get("OFFGRID_WHISPER_LIVE_MODEL", "small")  # чернетка наживо; "" — вимкнути
WHISPER_DEVICE = os.environ.get("OFFGRID_WHISPER_DEVICE", "auto").lower()         # auto | cpu | gpu
WHISPER_GPU_MODEL = os.environ.get("OFFGRID_WHISPER_GPU_MODEL", "large-v3-turbo")
WHISPER_DIR = os.environ.get("OFFGRID_WHISPER_DIR", r"E:\AI\whisper")
PIPER_VOICE = Path(os.environ.get("OFFGRID_PIPER_VOICE", r"E:\AI\piper\uk_UA-mykyta-high.onnx"))
SPEECH_SPEED = float(os.environ.get("OFFGRID_SPEECH_SPEED", "1.0"))  # >1 — повільніше, <1 — швидше

SAMPLE_RATE = 16000        # Whisper очікує 16 кГц, моно
BLOCK_S = 0.03             # аналізуємо звук шматками по 30 мс
PRE_ROLL_S = 0.4           # скільки звуку ДО спрацювання зберігати, щоб не обрізати перше слово
SILENCE_TO_STOP_S = 1.0    # стільки тиші після мови = кінець фрази
SPECULATE_AFTER_S = 0.35   # після такої паузи починаємо точне розпізнавання «наперед»
SPECULATE = os.environ.get("OFFGRID_WHISPER_AHEAD", "1") != "0"
STRICT_SPEECH_S = 0.25     # у режимі strict стільки звуку поспіль має бути гучнішим за поріг
SETTLE_AFTER_SPEECH_S = 0.4  # пауза між кінцем власного голосу й початком запису: колонки й відлуння мають затихнути
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
CPU_THREADS = max(4, (os.cpu_count() or 8) // 2)


def load_gpu_whisper():
    """Пробує завантажити Whisper на відеокарту. Повертає модель або None (тоді працюємо на процесорі)."""
    if WHISPER_DEVICE == "cpu":
        return None
    # Бібліотеки NVIDIA лежать у папці проєкту, а не в системі. Без них навіть не пробуємо:
    # спроба завантажити модель на відеокарту без cuBLAS/cuDNN не падає з помилкою, а зависає.
    dirs = [Path(__file__).resolve().parent / "vendor" / "nvidia" / sub / "bin" for sub in ("cublas", "cudnn", "cuda_nvrtc")]
    if not (dirs[0] / "cublas64_12.dll").is_file() or not (dirs[1] / "cudnn64_9.dll").is_file():
        if WHISPER_DEVICE == "gpu":
            log("Розпізнавання на відеокарті недоступне: у speech\\vendor немає бібліотек NVIDIA — працюю на процесорі")
        return None
    try:
        for d in dirs:
            if d.is_dir():
                os.add_dll_directory(str(d))
                os.environ["PATH"] = str(d) + os.pathsep + os.environ.get("PATH", "")
        import ctranslate2
        if ctranslate2.get_cuda_device_count() < 1:
            return None
        t = time.perf_counter()
        model = WhisperModel(WHISPER_GPU_MODEL, device="cuda", compute_type="int8_float16",
                             download_root=WHISPER_DIR, local_files_only=True)
        # прогрів: перший виклик на відеокарті помітно довший за наступні
        list(model.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32), language="uk", beam_size=1)[0])
        log(f"Whisper '{WHISPER_GPU_MODEL}' завантажено на відеокарту за {time.perf_counter() - t:.1f} с")
        return model
    except Exception as e:  # noqa: BLE001 — будь-який збій відеокарти: тихо переходимо на процесор
        log(f"Розпізнавання на відеокарті не запустилось ({str(e)[:200]}) — працюю на процесорі")
        return None


whisper = load_gpu_whisper()
ON_GPU = whisper is not None
if ON_GPU:
    # на відеокарті одна модель встигає все: окрема чернетка й розпізнавання наперед не потрібні
    WHISPER_MODEL, WHISPER_LIVE_MODEL, SPECULATE = WHISPER_GPU_MODEL, "", False
    PARTIAL_EVERY_S = 0.4
else:
    t0 = time.perf_counter()
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

LIVE_LOCK = threading.Lock()      # одну модель Whisper не можна викликати з двох потоків одночасно
LISTEN_LOCK = threading.Lock()    # один запис за раз
STOP_LISTEN = threading.Event()   # «закінчити запис і розпізнати»
CANCEL_LISTEN = threading.Event() # «скасувати запис»

# Точна модель у двох примірниках: один може бути зайнятий розпізнаванням «наперед» (див. listen),
# яке виявилось зайвим, бо людина заговорила далі. Другий примірник не дає цьому затримати справжній результат.
FINAL_MODELS = [(whisper, threading.Lock())]
if SPECULATE:
    try:
        FINAL_MODELS.append((WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8", cpu_threads=CPU_THREADS,
                                          download_root=WHISPER_DIR, local_files_only=True), threading.Lock()))
    except Exception as e:  # noqa: BLE001 — без другого примірника працюємо як раніше
        log(f"Другий примірник '{WHISPER_MODEL}' не завантажився: {e}")
# з одним примірником зайве розпізнавання наперед затримувало б справжнє — тоді його не робимо
SPECULATE = SPECULATE and len(FINAL_MODELS) > 1

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


GPU_LOADED = ON_GPU  # чи модель розпізнавання зараз у відеопам'яті (після /sleep — ні)


def gpu_sleep():
    """Вивантажує модель розпізнавання з відеокарти. Повертає True, якщо відеопам'ять справді звільнено."""
    global GPU_LOADED
    if not ON_GPU:
        return False
    with FINAL_MODELS[0][1]:
        if not GPU_LOADED:
            return False
        whisper.model.unload_model()
        GPU_LOADED = False
        return True


def gpu_wake():
    """Повертає модель на відеокарту заздалегідь (у фоні, поки людина ще говорить)."""
    if ON_GPU and not GPU_LOADED:
        with FINAL_MODELS[0][1]:
            _ensure_loaded(whisper)


def _ensure_loaded(model):
    """Викликається з уже захопленим замком моделі."""
    global GPU_LOADED
    if ON_GPU and model is whisper and not GPU_LOADED:
        model.model.load_model()
        GPU_LOADED = True


def _run(model, audio, quick):
    _ensure_loaded(model)
    segments, _ = model.transcribe(
        audio, language="uk", beam_size=1, vad_filter=not quick, condition_on_previous_text=False,
        initial_prompt=INITIAL_PROMPT, without_timestamps=True,
    )
    return " ".join(s.text.strip() for s in segments).strip()


def acquire_final(wait=True):
    """Повертає вільний примірник точної моделі (model, lock) із захопленим замком або None."""
    for model, lock in FINAL_MODELS:
        if lock.acquire(blocking=False):
            return model, lock
    if not wait:
        return None
    while True:  # беремо той примірник, що звільниться першим
        for model, lock in FINAL_MODELS:
            if lock.acquire(timeout=0.02):
                return model, lock


def transcribe(audio, quick=False):
    """quick=True — чернетка малою моделлю (якщо вона є); інакше точний остаточний текст."""
    if quick and whisper_live is not None:
        with LIVE_LOCK:
            return _run(whisper_live, audio, True)
    model, lock = acquire_final()
    try:
        return _run(model, audio, quick)
    finally:
        lock.release()


class Speculation:
    """Точне розпізнавання «наперед»: запускається, щойно людина зробила коротку паузу.
    Якщо після паузи вона так і не заговорила — результат уже готовий (або майже готовий),
    і чекати на нього доводиться приблизно на секунду менше."""

    def __init__(self, audio, speech_mark, slot):
        self.speech_mark = speech_mark  # скільки мовлення було на момент запуску
        self.text = None
        self.error = None
        self.done = threading.Event()
        self.thread = threading.Thread(target=self._work, args=(audio, slot), daemon=True)
        self.thread.start()

    def _work(self, audio, slot):
        model, lock = slot
        try:
            self.text = _run(model, audio, False)
        except Exception as e:  # noqa: BLE001
            self.error = e
        finally:
            lock.release()
            self.done.set()


def listen(emit, wait_s=WAIT_FOR_SPEECH_S, strict=False):
    """Пише з мікрофона до паузи. emit(dict) надсилає подію клієнту. Повертає нічого: усе через emit."""
    if MIC_ERROR:
        calibrate()
        if MIC_ERROR:
            emit({"type": "error", "error": MIC_ERROR})
            return
    # Прапорці STOP/CANCEL тут НЕ скидаємо: їх ставлять лише під час запису й прибирають після нього
    # (див. _listen_stream), тож «скасувати», надіслане в першу ж мить, не загубиться.
    chunks, started, silence, waited, total = [], False, 0.0, 0.0, 0.0
    speech_mark = 0     # кількість шматків звуку на момент останнього почутого мовлення
    spec = None         # останнє розпізнавання «наперед»
    quiet_levels = []   # гучність, поки чекали на мову: з неї уточнюємо поріг
    pre_roll = deque(maxlen=int((PRE_ROLL_S + (STRICT_SPEECH_S if strict else 0)) / BLOCK_S))
    need_loud = STRICT_SPEECH_S if strict else 0.0  # скільки гучного звуку треба, щоб вважати це мовою
    loud = 0.0
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

    # якщо відеопам'ять була звільнена — повертаємо модель у фоні, не затримуючи початок запису
    if ON_GPU and not GPU_LOADED:
        threading.Thread(target=gpu_wake, daemon=True).start()
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
                    loud = loud + BLOCK_S if rms > THRESHOLD else max(0.0, loud - BLOCK_S)
                    if rms > THRESHOLD and loud >= need_loud:
                        started = True
                        chunks.extend(pre_roll)
                        chunks.append(data.copy())
                        speech_mark = len(chunks)
                        emit({"type": "speech"})
                    elif waited > wait_s:
                        set_threshold(quiet_levels)  # нічого не почули — можливо, поріг застарів
                        break
                    else:
                        pre_roll.append(data.copy())
                        quiet_levels.append(rms)
                    continue
                chunks.append(data.copy())
                total += BLOCK_S
                if rms < THRESHOLD:
                    silence += BLOCK_S
                else:
                    silence = 0.0
                    speech_mark = len(chunks)
                if silence >= SILENCE_TO_STOP_S or total >= MAX_RECORD_S:
                    break
                # коротка пауза: починаємо точне розпізнавання наперед (якщо для цього мовлення ще не починали)
                # (одне за раз: поки попереднє не закінчилось, другий примірник моделі лишається вільним для справжнього)
                if (SPECULATE and silence >= SPECULATE_AFTER_S and total >= 0.5
                        and (spec is None or (spec.done.is_set() and spec.speech_mark != speech_mark))):
                    slot = acquire_final(wait=False)
                    if slot is not None:
                        try:
                            spec = Speculation(np.concatenate(chunks).flatten(), speech_mark, slot)
                        except Exception:  # noqa: BLE001 — потік не стартував: замок треба повернути
                            slot[1].release()
                # проміжний текст: розпізнаємо все сказане досі, якщо попереднє розпізнавання вже закінчилось
                if ((whisper_live is not None or ON_GPU) and silence < SPECULATE_AFTER_S and total - last_partial >= PARTIAL_EVERY_S
                        and total >= 0.6 and not partial_busy.is_set()):
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
    ahead = False
    try:
        text = None
        # розпізнавання наперед годиться, якщо після його запуску людина більше нічого не сказала
        if spec is not None and spec.speech_mark == speech_mark:
            while not spec.done.wait(0.05):
                if CANCEL_LISTEN.is_set():
                    emit({"type": "cancelled"})
                    return
            if spec.error is None:
                text, ahead = spec.text, True
        if text is None:
            text = transcribe(np.concatenate(chunks).flatten())
    except Exception as e:  # noqa: BLE001
        emit({"type": "error", "error": f"Не вдалося розпізнати мову: {e}"})
        return
    if CANCEL_LISTEN.is_set():
        emit({"type": "cancelled"})
        return
    emit({"type": "final", "text": text, "record_s": record_s, "stt_s": time.perf_counter() - t1, "ahead": ahead})


def piper_synth(text):
    """Синтез голосом Piper: віддає звук реченнями."""
    if LOWERCASE_TEXT:
        text = text.lower()
    for chunk in voice.synthesize(text, syn_config=syn_config):
        yield chunk.audio_float_array, chunk.sample_rate


speaker = Speaker(piper_synth, MAX_SPEAK_CHARS)


class Handler(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        length = min(int(self.headers.get("Content-Length", 0) or 0), 64 * 1024)
        try:
            data = json.loads(self.rfile.read(length) or b"{}") if length else {}
        except ValueError:
            data = {}
        return data if isinstance(data, dict) else {}

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
            self._json(200, {"ok": True, "device": "gpu" if ON_GPU else "cpu", "gpu_loaded": GPU_LOADED, "whisper": WHISPER_MODEL,
                             "live": WHISPER_MODEL if ON_GPU else (WHISPER_LIVE_MODEL if whisper_live else None),
                             "ahead": len(FINAL_MODELS) > 1, "voice": PIPER_VOICE.stem, "mic_error": MIC_ERROR})
        else:
            self._json(404, {"ok": False, "error": "not found"})

    def _listen_stream(self, wait_s, strict):
        if not LISTEN_LOCK.acquire(blocking=False):
            return self._json(409, {"ok": False, "error": "Я вже слухаю"})
        try:
            # слухати й говорити одночасно не можна: інакше асистент запише власний голос як команду
            if speaker.active:
                speaker.cancel()
            for _ in range(40):  # чекаємо, доки звук справді обірветься
                if not speaker.playing:
                    break
                time.sleep(0.025)
            # ...і ще трохи, щоб у мікрофон не потрапив хвіст власного голосу
            settle = SETTLE_AFTER_SPEECH_S - (time.perf_counter() - speaker.ended_at)
            if 0 < settle <= SETTLE_AFTER_SPEECH_S:
                time.sleep(settle)
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

            listen(emit, wait_s, strict)
        finally:
            STOP_LISTEN.clear()
            CANCEL_LISTEN.clear()
            LISTEN_LOCK.release()
            self.close_connection = True

    def do_POST(self):
        if not self._authorized():
            return
        try:
            data = self._body()
            if self.path == "/listen":
                wait_s = data.get("wait_s", WAIT_FOR_SPEECH_S)
                wait_s = float(wait_s) if isinstance(wait_s, (int, float)) and not isinstance(wait_s, bool) else WAIT_FOR_SPEECH_S
                self._listen_stream(min(15.0, max(2.0, wait_s)), data.get("strict") is True)
            elif self.path == "/wake":
                # повернути розпізнавання на відеокарту заздалегідь (у фоні), щоб наступний запис не чекав
                if ON_GPU and not GPU_LOADED:
                    threading.Thread(target=gpu_wake, daemon=True).start()
                self._json(200, {"ok": True})
            elif self.path == "/sleep":
                if LISTEN_LOCK.locked():
                    return self._json(409, {"ok": False, "error": "Я зараз слухаю"})
                self._json(200, {"ok": True, "freed": gpu_sleep()})
            elif self.path == "/stop":
                if LISTEN_LOCK.locked():  # поза записом прапорець не ставимо, щоб не зачепити наступний
                    STOP_LISTEN.set()
                self._json(200, {"ok": True})
            elif self.path == "/cancel":
                if LISTEN_LOCK.locked():
                    CANCEL_LISTEN.set()
                speaker.cancel()
                self._json(200, {"ok": True})
            elif self.path in ("/say", "/speak"):
                text = str(data.get("text", "")).strip()
                if LISTEN_LOCK.locked():
                    return self._json(409, {"ok": False, "error": "Я зараз слухаю"})
                accepted = speaker.say(text) if text else True
                if self.path == "/say":
                    return self._json(200, {"ok": True, "accepted": accepted})
                result = speaker.finish()
                self._json(200 if not result["error"] else 500, {"ok": not result["error"], **result})
            elif self.path == "/say-done":
                result = speaker.finish()
                self._json(200 if not result["error"] else 500, {"ok": not result["error"], **result})
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
    log(f"READY http://{HOST}:{server.server_address[1]} stt={'gpu' if ON_GPU else 'cpu'}")
    server.serve_forever()
