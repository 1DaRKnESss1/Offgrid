"""
Текст із документів для асистента Offgrid: Word (.docx), PDF і прості текстові файли.
Запускає його застосунок (src/tools/doctext.js); одне завдання у вигляді JSON приходить на stdin, відповідь — JSON у stdout.

  {"cmd": "text", "path": "...", "max_chars": 60000}
      -> {"ok": true, "text": "...", "chars": N, "truncated": bool, "pages": N}
  {"cmd": "search", "roots": ["..."], "exts": [".docx", ...], "read_exts": [".docx", ...], "words": ["нейрон", ...],
   "since": 1731500000, "limit": 6, "budget_s": 25}
      -> {"ok": true, "results": [{"path", "modified", "size", "score", "snippet"}], "scanned": N, "timed_out": bool}

Цей скрипт лише ЧИТАЄ. Які папки й типи файлів можна чіпати, вирішує застосунок і передає сюди готовим списком:
сам скрипт нічого не розширює, не йде за посиланнями й точками з'єднання, не заходить у приховані папки.
Знайдені шляхи застосунок потім ще раз перевіряє своїм захистом, перш ніж щось відкрити чи прочитати.
"""
import json
import os
import sys
import time

MAX_TEXT_BYTES = 2 * 1024 * 1024      # прості текстові файли читаємо до 2 МБ
MAX_DOC_BYTES = 60 * 1024 * 1024      # документи більші за 60 МБ не чіпаємо
MAX_FILES = 4000
MAX_DEPTH = 6
SEARCH_PDF_PAGES = 40                 # для пошуку досить початку документа
TEXT_PDF_PAGES = 400

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass


def read_plain(path, limit):
    with open(path, "rb") as f:
        raw = f.read(min(limit, MAX_TEXT_BYTES))
    for enc in ("utf-8-sig", "cp1251"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def read_docx(path, max_chars):
    import docx  # python-docx
    doc = docx.Document(path)
    parts, size = [], 0
    for p in doc.paragraphs:
        if p.text.strip():
            parts.append(p.text)
            size += len(p.text)
            if size > max_chars:
                break
    if size <= max_chars:
        for table in doc.tables:
            for row in table.rows:
                line = " | ".join(c.text.strip() for c in row.cells if c.text.strip())
                if line:
                    parts.append(line)
                    size += len(line)
            if size > max_chars:
                break
    return "\n".join(parts), None


def read_pdf(path, max_chars, max_pages):
    import pymupdf  # PyMuPDF
    parts, size = [], 0
    with pymupdf.open(path) as doc:
        pages = doc.page_count
        for i, page in enumerate(doc):
            if i >= max_pages or size > max_chars:
                break
            t = page.get_text()
            parts.append(t)
            size += len(t)
    return "\n".join(parts), pages


def extract(path, max_chars, pdf_pages=TEXT_PDF_PAGES):
    """Повертає (текст, сторінок або None)."""
    ext = os.path.splitext(path)[1].lower()
    if os.path.getsize(path) > MAX_DOC_BYTES:
        raise ValueError("файл завеликий")
    if ext == ".docx":
        return read_docx(path, max_chars)
    if ext == ".pdf":
        return read_pdf(path, max_chars, pdf_pages)
    return read_plain(path, max_chars * 4), None


def squeeze(text):
    return " ".join(text.split())


def cmd_text(job):
    path = job["path"]
    max_chars = max(500, min(int(job.get("max_chars", 60000)), 200000))
    text, pages = extract(path, max_chars)
    text = text.replace("\x00", "")
    return {"ok": True, "text": text[:max_chars], "chars": len(text), "truncated": len(text) > max_chars, "pages": pages}


def cmd_search(job):
    roots = [r for r in job.get("roots", []) if isinstance(r, str)]
    exts = {e.lower() for e in job.get("exts", [])}
    read_exts = {e.lower() for e in job.get("read_exts", [])}
    words = [w.lower() for w in job.get("words", []) if isinstance(w, str) and len(w) >= 3][:8]
    since = float(job.get("since") or 0)
    limit = max(1, min(int(job.get("limit", 6)), 12))
    deadline = time.monotonic() + max(3, min(float(job.get("budget_s", 25)), 60))

    files = []
    for root in roots:
        base_depth = root.rstrip("\\/").count(os.sep)
        for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
            # приховані папки, службові й ті, що є посиланнями, пропускаємо
            dirnames[:] = [d for d in dirnames if not d.startswith(".") and d not in ("node_modules", "$RECYCLE.BIN")
                           and not os.path.islink(os.path.join(dirpath, d))]
            if dirpath.count(os.sep) - base_depth >= MAX_DEPTH:
                dirnames[:] = []
            for name in filenames:
                if name.startswith(".") or name.startswith("~$"):
                    continue
                if os.path.splitext(name)[1].lower() not in exts:
                    continue
                full = os.path.join(dirpath, name)
                try:
                    if os.path.islink(full):
                        continue
                    st = os.stat(full)
                except OSError:
                    continue
                if st.st_mtime < since:
                    continue
                files.append((st.st_mtime, st.st_size, full, name))
                if len(files) >= MAX_FILES:
                    break
            if len(files) >= MAX_FILES:
                break
    files.sort(reverse=True)  # найновіші першими: якщо час скінчиться, свіже вже переглянуто

    results, scanned, timed_out = [], 0, False
    for mtime, size, full, name in files:
        lname = name.lower()
        score = sum(1 for w in words if w in lname)   # збіг у назві
        snippet = ""
        if words and os.path.splitext(name)[1].lower() in read_exts:
            if time.monotonic() > deadline:
                timed_out = True
            else:
                try:
                    text, _ = extract(full, 40000, SEARCH_PDF_PAGES)
                    scanned += 1
                    low = text.lower()
                    found = [w for w in words if w in low]
                    score += 2 * len(found)   # збіг у тексті важить більше
                    if found:
                        i = max(0, low.find(found[0]) - 70)
                        snippet = squeeze(text[i:i + 220])[:200]
                except Exception:  # noqa: BLE001 — зіпсований чи захищений файл просто пропускаємо
                    pass
        if words and score == 0:
            continue
        results.append({"path": full, "modified": int(mtime), "size": size, "score": score, "snippet": snippet})
    results.sort(key=lambda r: (-r["score"], -r["modified"]))
    if words and results:  # слабкі збіги поруч із сильними лише заважають
        best = results[0]["score"]
        results = [r for r in results if r["score"] * 2 >= best]
    return {"ok": True, "results": results[:limit], "total": len(results), "scanned": scanned, "timed_out": timed_out}


def main():
    try:
        job = json.loads(sys.stdin.buffer.read().decode("utf-8"))
        out = cmd_text(job) if job.get("cmd") == "text" else cmd_search(job) if job.get("cmd") == "search" else {"ok": False, "error": "невідома команда"}
    except Exception as e:  # noqa: BLE001
        out = {"ok": False, "error": str(e)[:300]}
    sys.stdout.write(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
