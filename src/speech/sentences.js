// Ділить текст, що надходить шматками, на речення — щоб озвучувати перше, не чекаючи всієї відповіді.
const BOUNDARY = /[.!?…]+["»”)]*\s+|\n+/g;
const MIN_CHARS = 12; // коротке «Так.» не озвучуємо окремо, а приєднуємо до наступного речення

export class SentenceSplitter {
  constructor(onSentence) {
    this.onSentence = onSentence;
    this.buffer = '';
  }

  push(delta) {
    this.buffer += String(delta ?? '');
    let cut = 0;
    BOUNDARY.lastIndex = 0;
    for (let m; (m = BOUNDARY.exec(this.buffer));) {
      const end = m.index + m[0].length;
      if (this.buffer.slice(cut, end).trim().length < MIN_CHARS) continue;
      this.#emit(this.buffer.slice(cut, end));
      cut = end;
    }
    this.buffer = this.buffer.slice(cut);
  }

  /** Відповідь закінчилась: віддаємо залишок. */
  flush() {
    this.#emit(this.buffer);
    this.buffer = '';
  }

  /** Усе накопичене відкидаємо (текст виявився не відповіддю, а вступом до виклику інструмента). */
  reset() {
    this.buffer = '';
  }

  #emit(text) {
    const sentence = text.trim();
    if (sentence) this.onSentence(sentence);
  }
}
