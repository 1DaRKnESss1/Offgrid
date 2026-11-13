"""
Сервіс якісного голосу Offgrid на OmniVoice. Працює лише на цьому комп'ютері, на відеокарті, без мережі.
Запускається із середовища speech\\tts-env самим застосунком (src/speech/voice.js); налаштування — змінними середовища:
  OFFGRID_SPEECH_PORT, OFFGRID_SPEECH_TOKEN, OFFGRID_VOICE_PROMPT (відбиток голосу .pt) або OFFGRID_VOICE_INSTRUCT
  (опис голосу), OFFGRID_VOICE_SPEED, OFFGRID_VOICE_STEPS, HF_HOME (де лежить модель)

Адреса: http://127.0.0.1:<порт>, кожен запит — із заголовком X-Offgrid-Token.
  GET  /health   -> стан
  POST /say      -> тіло {"text": "речення"}; додає речення до озвучення й одразу повертається
  POST /say-done -> більше речень не буде; чекає, доки все прозвучить: {"ok":true,"interrupted":..,"audio_s":..}
  POST /speak    -> /say і /say-done разом
  POST /cancel   -> замовкнути
  POST /sleep    -> звільнити відеопам'ять (модель переїжджає у звичайну пам'ять)
  POST /wake     -> повернути модель на відеокарту заздалегідь (інакше це станеться з першим реченням)

Відеопам'ять. Модель займає там близько 1,3 ГБ, але потрібна лише тоді, коли асистент говорить, а переїзд між
звичайною пам'яттю й відеокартою триває 0,3 с. Тому між відповідями вона лежить у звичайній пам'яті, а її місце
на відеокарті в цей час займає розпізнавання мови — вони ніколи не працюють одночасно. Постійно зайнятими
лишаються близько 0,9 ГБ (службові дані PyTorch), їх звільняє лише зупинка сервісу.
"""
import hmac
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

os.environ.setdefault("HF_HOME", r"E:\AI\omnivoice")
os.environ["HF_HUB_OFFLINE"] = "1"            # модель уже на диску: жодних звернень у мережу
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

HOST = "127.0.0.1"
PORT = int(os.environ.get("OFFGRID_SPEECH_PORT", "0"))
TOKEN = os.environ.get("OFFGRID_SPEECH_TOKEN", "")
PROMPT_FILE = os.environ.get("OFFGRID_VOICE_PROMPT", "")
INSTRUCT = os.environ.get("OFFGRID_VOICE_INSTRUCT", "")
SPEED = float(os.environ.get("OFFGRID_VOICE_SPEED", "1.1"))
STEPS = int(os.environ.get("OFFGRID_VOICE_STEPS", "16"))
LANGUAGE = os.environ.get("OFFGRID_VOICE_LANGUAGE", "Ukrainian")
MAX_SPEAK_CHARS = 1500


def log(msg):
    print(msg, flush=True)


if not TOKEN:
    sys.exit("Не задано OFFGRID_SPEECH_TOKEN: сервіс запускається лише застосунком Offgrid")

import torch  # noqa: E402

if not torch.cuda.is_available():
    sys.exit("Відеокарта недоступна: на процесорі цей голос надто повільний")

from omnivoice import OmniVoice, VoiceClonePrompt  # noqa: E402
from omnivoice.models.omnivoice import OmniVoiceGenerationConfig  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
from speaker import Speaker  # noqa: E402

t0 = time.perf_counter()
model = OmniVoice.from_pretrained("k2-fsa/OmniVoice", device_map="cuda:0", dtype=torch.float16)
config = OmniVoiceGenerationConfig(num_step=STEPS)
prompt = None
if PROMPT_FILE:
    if not Path(PROMPT_FILE).is_file():
        sys.exit(f"Не знайдено відбиток голосу: {PROMPT_FILE}")
    prompt = VoiceClonePrompt.load(PROMPT_FILE)
VOICE_ARGS = {"voice_clone_prompt": prompt} if prompt is not None else ({"instruct": INSTRUCT} if INSTRUCT else {})

MODEL_LOCK = threading.Lock()  # одна генерація за раз; під цим же замком модель переїжджає між пам'ятями
ON_GPU = True


def _move(device):
    model.to(device)
    model.audio_tokenizer.to(device)  # сам model.to() звуковий кодек не переносить


def _to_gpu():
    """Викликається з уже захопленим MODEL_LOCK."""
    global ON_GPU
    if not ON_GPU:
        _move("cuda:0")
        ON_GPU = True


def synth(text):
    with MODEL_LOCK:
        _to_gpu()
        audio = model.generate(text=text, language=LANGUAGE, speed=SPEED, generation_config=config, **VOICE_ARGS)[0]
    yield audio, 24000


def sleep_model():
    """Звільняє відеопам'ять. Повертає True, якщо модель справді переїхала."""
    global ON_GPU
    with MODEL_LOCK:
        if not ON_GPU:
            return False
        _move("cpu")
        ON_GPU = False
        torch.cuda.empty_cache()
        return True


def wake_model():
    with MODEL_LOCK:
        _to_gpu()


# прогрів: перша генерація на відеокарті найдовша — хай вона станеться до першої справжньої відповіді
list(synth("Привіт."))
log(f"OmniVoice завантажено за {time.perf_counter() - t0:.1f} с (кроків: {STEPS}, темп: {SPEED}, "
    f"голос: {'відбиток ' + Path(PROMPT_FILE).name if prompt is not None else (INSTRUCT or 'типовий')})")

sleep_model()  # між відповідями модель чекає у звичайній пам'яті

speaker = Speaker(synth, MAX_SPEAK_CHARS)


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
            self._json(200, {"ok": True, "engine": "omnivoice", "on_gpu": ON_GPU, "speaking": speaker.active,
                             "steps": STEPS, "speed": SPEED})
        else:
            self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if not self._authorized():
            return
        try:
            data = self._body()
            if self.path in ("/say", "/speak"):
                text = str(data.get("text", "")).strip()
                accepted = speaker.say(text) if text else True
                if self.path == "/say":
                    return self._json(200, {"ok": True, "accepted": accepted})
                result = speaker.finish()
                self._json(200 if not result["error"] else 500, {"ok": not result["error"], **result})
            elif self.path == "/say-done":
                result = speaker.finish()
                self._json(200 if not result["error"] else 500, {"ok": not result["error"], **result})
            elif self.path == "/cancel":
                speaker.cancel()
                self._json(200, {"ok": True, "ended_s": max(0.0, time.perf_counter() - speaker.ended_at)})
            elif self.path == "/sleep":
                if speaker.active:
                    return self._json(409, {"ok": False, "error": "Я ще говорю"})
                self._json(200, {"ok": True, "freed": sleep_model()})
            elif self.path == "/wake":
                wake_model()
                self._json(200, {"ok": True})
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
    log(f"READY http://{HOST}:{server.server_address[1]} voice=omnivoice")
    server.serve_forever()
