"""
Озвучення по реченнях без пауз між ними — спільне для обох голосових рушіїв (Piper і OmniVoice).

Один потік синтезує речення з черги, другий відтворює готовий звук: поки звучить одне речення, наступне вже
синтезується. Сам синтез передається ззовні функцією synth(текст), тому клас не знає, який рушій говорить.
"""
import queue
import threading
import time

import numpy as np
import sounddevice as sd


class Speaker:
    """Озвучення по реченнях без пауз між ними.
    Один потік синтезує речення з черги, другий відтворює готовий звук: поки звучить одне речення,
    наступне вже синтезується. Речення можна додавати, доки триває відповідь моделі (say),
    а finish() чекає, доки все договорено."""

    def __init__(self, synth, max_chars=1500):
        self.synth = synth          # synth(текст) -> послідовність (звук float32, частота)
        self.max_chars = max_chars  # скільки символів озвучуємо за одну відповідь
        self.lock = threading.Lock()
        self.gen = 0               # зростає з кожним «замовкни»: усе зі старим номером викидається
        self.active = False        # є що говорити або ще звучить
        self.done = threading.Event()
        self.done.set()
        self.interrupted = False
        self.error = None
        self.audio_s = 0.0
        self.chars = 0
        self.started_at = 0.0
        self.first_audio_s = 0.0
        self.fresh = False         # було нове висловлювання, про яке finish() ще не звітував
        self.ending = False        # кінець висловлювання вже в черзі, але воно ще звучить
        self.playing = False       # вихідний потік звуку відкрито
        self.ended_at = 0.0        # коли звук востаннє замовк
        self.texts = queue.Queue()  # (gen, текст) або (gen, None) — кінець висловлювання
        self.audio = queue.Queue()  # (gen, масив, частота) або (gen, None, None)
        threading.Thread(target=self._synth_loop, daemon=True).start()
        threading.Thread(target=self._play_loop, daemon=True).start()

    def say(self, text):
        # попереднє висловлювання ще договорюється після finish(): нове починаємо, коли воно закінчиться
        for _ in range(600):
            if not self.ending:
                break
            self.done.wait(0.1)
        with self.lock:
            if not self.active:
                self.active, self.interrupted, self.error = True, False, None
                self.audio_s, self.chars, self.first_audio_s = 0.0, 0, 0.0
                self.started_at = time.perf_counter()
                self.fresh = True
                self.done.clear()
            room = self.max_chars - self.chars
            if room <= 0:
                return False
            text = text[:room]
            self.chars += len(text)
            self.texts.put((self.gen, text))
            return True

    def finish(self):
        """Більше тексту не буде. Чекає, доки все прозвучить, і повертає підсумок."""
        with self.lock:
            if not self.fresh:  # нічого нового не говорили — старий підсумок не повторюємо
                return {"interrupted": False, "audio_s": 0.0, "first_audio_s": 0.0, "error": None}
            if self.active and not self.ending:
                self.ending = True
                self.texts.put((self.gen, None))
        self.done.wait()
        with self.lock:
            self.fresh = False
            return {"interrupted": self.interrupted, "audio_s": self.audio_s, "first_audio_s": self.first_audio_s,
                    "error": self.error}

    def cancel(self):
        with self.lock:
            if not self.active:
                return
            old = self.gen
            self.gen += 1
            self.interrupted = True
            self.active = False
            self.ending = False
            for q in (self.texts, self.audio):
                try:
                    while True:
                        q.get_nowait()
                except queue.Empty:
                    pass
            self.audio.put((old, None, None))  # будимо відтворення, щоб воно негайно обірвало звук
            self.done.set()

    def _fail(self, gen, message):
        with self.lock:
            if gen != self.gen or not self.active:
                return
            self.error = message
            self.gen += 1
            self.active = False
            self.ending = False
            self.audio.put((gen, None, None))
            self.done.set()

    def _synth_loop(self):
        while True:
            gen, text = self.texts.get()
            if gen != self.gen:
                continue
            if text is None:
                self.audio.put((gen, None, None))
                continue
            try:
                for audio, rate in self.synth(text):
                    if gen != self.gen:
                        break
                    self.audio.put((gen, np.asarray(audio, dtype=np.float32), rate))
            except Exception as e:  # noqa: BLE001
                self._fail(gen, f"Не вдалося синтезувати мову: {e}")

    def _play_loop(self):
        stream, stream_gen = None, None

        def close(abort):
            nonlocal stream, stream_gen
            if stream is not None:
                try:
                    if abort:
                        stream.abort()
                    else:
                        stream.stop()
                    stream.close()
                except Exception:  # noqa: BLE001
                    pass
                self.ended_at = time.perf_counter()
                self.playing = False
            stream, stream_gen = None, None

        while True:
            gen, audio, rate = self.audio.get()
            if gen != self.gen:          # застарілий звук або сигнал «замовкни»
                if stream_gen is not None and stream_gen != self.gen:
                    close(abort=True)
                continue
            if audio is None:            # кінець висловлювання: даємо договорити й закриваємо
                close(abort=False)
                with self.lock:
                    if gen == self.gen:
                        self.active = False
                        self.ending = False
                        self.done.set()
                continue
            try:
                if stream is None:
                    stream = sd.OutputStream(samplerate=rate, channels=1, dtype="float32")
                    stream.start()
                    self.playing = True
                    stream_gen = gen
                    self.first_audio_s = time.perf_counter() - self.started_at
                step = int(rate * 0.05)  # пишемо по 50 мс, щоб швидко реагувати на «замовкни»
                for i in range(0, len(audio), step):
                    if gen != self.gen:
                        break
                    stream.write(audio[i:i + step].reshape(-1, 1))
                if gen != self.gen:
                    close(abort=True)
                else:
                    self.audio_s += len(audio) / rate
            except Exception as e:  # noqa: BLE001
                close(abort=True)
                self._fail(gen, f"Не вдалося відтворити звук: {e}")
