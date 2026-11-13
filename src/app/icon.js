// Іконка трею малюється кодом (кільце з крапкою), щоб не тримати в репозиторії бінарних файлів.
// Колір залежить від стану асистента.
import zlib from 'node:zlib';

const COLORS = {
  idle: [150, 160, 175],
  listening: [46, 160, 255],
  thinking: [255, 185, 0],
  executing: [255, 140, 0],
  confirming: [255, 185, 0],
  speaking: [80, 200, 120],
  error: [232, 72, 85],
};

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}

export function iconPng(state = 'idle', size = 32) {
  const [r, g, b] = COLORS[state] ?? COLORS.idle;
  const c = (size - 1) / 2;
  const outer = size * 0.46, inner = size * 0.33, dot = size * 0.16;
  // покриття пікселя фігурою з м'яким краєм у 1 піксель
  const edge = (d, radius) => Math.max(0, Math.min(1, radius - d + 0.5));
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // тип фільтра рядка PNG
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const alpha = Math.max(edge(d, outer) - edge(d, inner), edge(d, dot));
      const i = row + 1 + x * 4;
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; raw[i + 3] = Math.round(alpha * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8 біт на канал, RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
