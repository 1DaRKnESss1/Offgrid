// Ділить текст, що надходить шматками, на речення — щоб озвучувати перше, не чекаючи всієї відповіді.
const BOUNDARY = /[.!?…]+["»”)]*\s+|\n+/g;
const MIN_CHARS = 12; // коротке «Так.» не озвучуємо окремо, а приєднуємо до наступного речення
// Після цих скорочень крапка — не кінець речення («на вул. Шевченка, буд. 5»)
const ABBREVIATIONS = new Set(['вул', 'буд', 'кв', 'просп', 'пл', 'пров', 'м', 'с', 'обл', 'р', 'рр', 'ст', 'т', 'д', 'ін', 'напр',
  'див', 'грн', 'коп', 'тис', 'млн', 'млрд', 'хв', 'год', 'сек', 'проф', 'ім', 'п', 'стор', 'табл', 'рис', 'наприкл', 'тощо']);

function endsWithAbbreviation(text) {
  const m = text.match(/(?:^|[^\p{L}])(\p{L}{1,7})\.\s*$/u);
  return !!m && ABBREVIATIONS.has(m[1].toLowerCase());
}

export class SentenceSplitter {
  constructor(onSentence) {
    this.onSentence = onSentence;
    this.buffer = '';
  }

  push(delta) {
    this.buffer += String(delta ?? '');
    let cut = 0;
    const boundary = new RegExp(BOUNDARY.source, 'g'); // власний екземпляр: спільний lastIndex між викликами — джерело помилок
    for (let m; (m = boundary.exec(this.buffer));) {
      const end = m.index + m[0].length;
      const piece = this.buffer.slice(cut, end);
      if (piece.trim().length < MIN_CHARS) continue;
      if (m[0].startsWith('.') && endsWithAbbreviation(piece)) continue;
      this.#emit(piece);
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
