// «Сон» асистента: коли ним не користуються, модель і розпізнавання мови звільняють відеопам'ять,
// щоб комп'ютер був вільний для ігор та іншої роботи. Прокидається сам із першою ж командою.
//
// Три причини заснути:
//   idle     — минуло idleUnloadMinutes хвилин без команд;
//   manual   — користувач натиснув «Звільнити відеопам'ять» у треї;
//   pressure — відеопам'яті бракує іншій програмі (наприклад, запустили гру).
//
// Тут лише рішення й таймери; самі дії (вивантажити, завантажити) передаються ззовні — так це можна тестувати.

export const PRESSURE_FREE_MB = 200;   // менше вільної відеопам'яті — вважаємо, що комусь тісно
export const PRESSURE_CHECKS = 2;      // стільки вимірів поспіль, щоб не реагувати на короткий сплеск
export const PRESSURE_INTERVAL_MS = 10_000;

export class Resources {
  /**
   * deps:
   *   getConfig()            — чинні налаштування (idleUnloadMinutes, yieldToOtherApps)
   *   isBusy()               — триває розмова або підбір розподілу: зараз засинати не можна
   *   release()              — звільнити пам'ять (async)
   *   readVram()             — { totalMb, usedMb } або null (async)
   *   onChange(asleep, why)  — стан змінився
   *   timers                 — { setTimeout, clearTimeout, setInterval, clearInterval } (підміняється в тестах)
   */
  constructor({ getConfig, isBusy, release, readVram, onChange = () => {}, timers = globalThis }) {
    Object.assign(this, { getConfig, isBusy, release, readVram, onChange, timers });
    this.asleep = false;
    this.idleTimer = null;
    this.watchTimer = null;
    this.tight = 0;
    this.sleeping = null; // обіцянка поточного засинання
  }

  start() {
    this.touch();
    this.watchTimer = this.timers.setInterval(() => { this.checkPressure(); }, PRESSURE_INTERVAL_MS);
  }

  stop() {
    this.timers.clearTimeout(this.idleTimer);
    this.timers.clearInterval(this.watchTimer);
  }

  /** Асистентом щойно користувалися (або змінилися налаштування): відлік простою починається знову. */
  touch() {
    this.timers.clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const minutes = this.getConfig().idleUnloadMinutes;
    if (this.asleep || !(minutes > 0)) return;
    this.idleTimer = this.timers.setTimeout(() => { this.sleep('idle'); }, minutes * 60_000);
  }

  /** Заснути. Повертає true, якщо пам'ять справді звільнено зараз. */
  async sleep(reason) {
    if (this.asleep || this.isBusy()) return false;
    if (this.sleeping) return this.sleeping;
    this.sleeping = (async () => {
      this.asleep = true; // одразу: нова команда має побачити «сплю» й розбудити як слід
      this.timers.clearTimeout(this.idleTimer);
      this.idleTimer = null;
      this.tight = 0;
      try { await this.release(); } catch { /* що змогли — звільнили */ }
      this.onChange(true, reason);
      return true;
    })();
    try { return await this.sleeping; } finally { this.sleeping = null; }
  }

  /** Прокинутися перед командою. Повертає true, якщо асистент спав (тоді треба заново ділити відеопам'ять). */
  async wake() {
    if (this.sleeping) await this.sleeping; // не будимо посеред засинання
    if (!this.asleep) return false;
    this.asleep = false;
    this.tight = 0;
    this.onChange(false, 'wake');
    return true;
  }

  /** Раз на кілька секунд: чи не бракує відеопам'яті комусь іншому. */
  async checkPressure() {
    if (this.asleep || this.isBusy() || !this.getConfig().yieldToOtherApps) { this.tight = 0; return false; }
    let vram = null;
    try { vram = await this.readVram(); } catch { /* вважаємо, що даних немає */ }
    if (!vram) return false;
    this.tight = vram.totalMb - vram.usedMb < PRESSURE_FREE_MB ? this.tight + 1 : 0;
    if (this.tight < PRESSURE_CHECKS) return false;
    return this.sleep('pressure');
  }
}
