// Synthetic images only. This generator draws pixels; it does not perform vision.
import { deflateSync } from 'node:zlib';
export const SCENES = ['uncovered', 'covered', 'obscured', 'unrelated'];

export function scenePng(scene) {
  if (!SCENES.includes(scene)) throw Error('Unknown synthetic scene');
  const width = 640, height = 400;
  const pixels = Buffer.alloc(width * height * 3);
  function rect(x, y, w, h, color) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) {
      if (i >= 0 && i < width && j >= 0 && j < height) pixels.set(color, (j * width + i) * 3);
    }
  }
  function circle(x, y, r, color, hollow = false) {
    for (let j = y - r; j <= y + r; j++) for (let i = x - r; i <= x + r; i++) {
      const d = (i - x) ** 2 + (j - y) ** 2;
      if (d <= r ** 2 && (!hollow || d >= (r - 3) ** 2)) rect(i, j, 1, 1, color);
    }
  }
  const white = [245, 245, 240], yellow = [255, 220, 40], blue = [35, 100, 255], red = [240, 50, 55];
  rect(0, 0, width, height, [17, 25, 40]);
  if (scene === 'unrelated') {
    rect(60, 50, 520, 300, [220, 225, 232]);
    for (let i = 0; i < 6; i++) rect(90, 80 + i * 40, 340 - i * 30, 10, [100, 110, 125]);
  } else {
    rect(30, 30, 580, 340, [30, 125, 65]);
    rect(30, 30, 580, 3, white); rect(30, 367, 580, 3, white);
    rect(30, 30, 3, 340, white); rect(607, 30, 3, 340, white);
    rect(319, 30, 3, 340, white); circle(320, 200, 48, white, true);
    rect(30, 120, 80, 3, white); rect(30, 277, 80, 3, white); rect(107, 120, 3, 160, white);
    rect(530, 120, 80, 3, white); rect(530, 277, 80, 3, white); rect(530, 120, 3, 160, white);
    rect(35, 35, 188, 4, yellow); rect(35, 361, 188, 4, yellow);
    rect(35, 35, 4, 330, yellow); rect(219, 35, 4, 330, yellow);
    circle(scene === 'covered' ? 145 : 280, 220, 14, blue);
    circle(370, 110, 14, blue); circle(420, 300, 14, blue);
    circle(170, 110, 14, red); circle(480, 160, 14, red); circle(490, 275, 14, red);
    circle(350, 230, 6, white);
    if (scene === 'obscured') rect(25, 80, 215, 240, [80, 85, 95]);
  }
  const scanlines = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) pixels.copy(scanlines, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  function chunk(type, bytes) {
    const data = Buffer.concat([Buffer.from(type), bytes]);
    let crc = 0xffffffff;
    for (const b of data) {
      crc ^= b;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const len = Buffer.alloc(4); len.writeUInt32BE(bytes.length);
    const sum = Buffer.alloc(4); sum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, data, sum]);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]);
}
