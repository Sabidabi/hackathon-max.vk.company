// Minimal QR Code encoder (ISO/IEC 18004, byte mode, ECC L/M) for «Откройте в MAX».
// No dependency on purpose: the project does not add npm packages, and the backend QR
// endpoint is per venue and needs a session. Encodes arbitrary UTF-8 text (a page URL).
// Checked against the Python `qrcode` library in tests/design.unit.mjs.

export type QrErrorCorrection = "L" | "M";

const ECC_FORMAT_BITS: Record<QrErrorCorrection, number> = { L: 1, M: 0 };

// Index = version (1..40). Values from the standard (table 9).
const ECC_CODEWORDS_PER_BLOCK: Record<QrErrorCorrection, number[]> = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
};
const ERROR_CORRECTION_BLOCKS: Record<QrErrorCorrection, number[]> = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
};

function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(version: number, ecl: QrErrorCorrection): number {
  return Math.floor(rawDataModules(version) / 8)
    - ECC_CODEWORDS_PER_BLOCK[ecl][version] * ERROR_CORRECTION_BLOCKS[ecl][version];
}

// --- Reed–Solomon over GF(2^8), polynomial 0x11D ----------------------------------------

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coefficient, index) => {
      result[index] ^= gfMultiply(coefficient, factor);
    });
  }
  return result;
}

// --- Matrix ------------------------------------------------------------------------------

class Matrix {
  readonly size: number;
  readonly modules: boolean[][];
  readonly reserved: boolean[][];

  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.reserved = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  setFunction(x: number, y: number, dark: boolean): void {
    this.modules[y][x] = dark;
    this.reserved[y][x] = true;
  }
}

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let position = version * 4 + 10; result.length < count; position -= step) {
    result.splice(1, 0, position);
  }
  return result;
}

function drawFinder(matrix: Matrix, cx: number, cy: number): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= matrix.size || y >= matrix.size) continue;
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      matrix.setFunction(x, y, distance !== 2 && distance !== 4);
    }
  }
}

function drawFormatBits(matrix: Matrix, ecl: QrErrorCorrection, mask: number): void {
  const data = (ECC_FORMAT_BITS[ecl] << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  const bits = ((data << 10) | remainder) ^ 0x5412;
  const bit = (i: number) => ((bits >>> i) & 1) !== 0;
  const size = matrix.size;
  for (let i = 0; i <= 5; i++) matrix.setFunction(8, i, bit(i));
  matrix.setFunction(8, 7, bit(6));
  matrix.setFunction(8, 8, bit(7));
  matrix.setFunction(7, 8, bit(8));
  for (let i = 9; i < 15; i++) matrix.setFunction(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) matrix.setFunction(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) matrix.setFunction(8, size - 15 + i, bit(i));
  matrix.setFunction(8, size - 8, true);
}

function drawVersion(matrix: Matrix): void {
  const version = matrix.version;
  if (version < 7) return;
  let remainder = version;
  for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  const bits = (version << 12) | remainder;
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) !== 0;
    const a = matrix.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    matrix.setFunction(a, b, dark);
    matrix.setFunction(b, a, dark);
  }
}

function drawFunctionPatterns(matrix: Matrix, ecl: QrErrorCorrection): void {
  const size = matrix.size;
  for (let i = 0; i < size; i++) {
    matrix.setFunction(6, i, i % 2 === 0);
    matrix.setFunction(i, 6, i % 2 === 0);
  }
  drawFinder(matrix, 3, 3);
  drawFinder(matrix, size - 4, 3);
  drawFinder(matrix, 3, size - 4);
  const positions = alignmentPositions(matrix.version);
  const last = positions.length - 1;
  positions.forEach((cy, i) => {
    positions.forEach((cx, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          matrix.setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    });
  });
  drawFormatBits(matrix, ecl, 0); // placeholder, redrawn with the chosen mask
  drawVersion(matrix);
}

function withErrorCorrection(data: number[], version: number, ecl: QrErrorCorrection): number[] {
  const blockCount = ERROR_CORRECTION_BLOCKS[ecl][version];
  const eccLength = ECC_CODEWORDS_PER_BLOCK[ecl][version];
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blockCount - (rawCodewords % blockCount);
  const shortBlockLength = Math.floor(rawCodewords / blockCount);
  const divisor = rsDivisor(eccLength);
  const blocks: number[][] = [];
  for (let i = 0, offset = 0; i < blockCount; i++) {
    const length = shortBlockLength - eccLength + (i < shortBlocks ? 0 : 1);
    const block = data.slice(offset, offset + length);
    offset += length;
    const ecc = rsRemainder(block, divisor);
    if (i < shortBlocks) block.push(0);
    blocks.push(block.concat(ecc));
  }
  const result: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLength - eccLength || j >= shortBlocks) result.push(block[i]);
    });
  }
  return result;
}

function drawCodewords(matrix: Matrix, codewords: number[]): void {
  const size = matrix.size;
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if (matrix.reserved[y][x] || bitIndex >= codewords.length * 8) continue;
        matrix.modules[y][x] = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0;
        bitIndex++;
      }
    }
  }
}

const MASKS: Array<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(matrix: Matrix, mask: number): void {
  const invert = MASKS[mask];
  for (let y = 0; y < matrix.size; y++) {
    for (let x = 0; x < matrix.size; x++) {
      if (!matrix.reserved[y][x] && invert(x, y)) matrix.modules[y][x] = !matrix.modules[y][x];
    }
  }
}

/** Penalty rules N1–N4 of the standard; the lowest score picks the mask. */
function penalty(modules: boolean[][]): number {
  const size = modules.length;
  const at = (x: number, y: number, vertical: boolean) => (vertical ? modules[x][y] : modules[y][x]);
  let score = 0;
  let dark = 0;
  for (const vertical of [false, true]) {
    for (let line = 0; line < size; line++) {
      let run = 1;
      for (let i = 1; i <= size; i++) {
        if (i < size && at(i, line, vertical) === at(i - 1, line, vertical)) {
          run++;
          continue;
        }
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
      // N3: 1:1:3:1:1 finder-like pattern with four light modules on either side.
      for (let i = 0; i + 7 <= size; i++) {
        const pattern = [true, false, true, true, true, false, true].every((value, k) => at(i + k, line, vertical) === value);
        if (!pattern) continue;
        const lightBefore = [1, 2, 3, 4].every((k) => i - k < 0 || !at(i - k, line, vertical));
        const lightAfter = [0, 1, 2, 3].every((k) => i + 7 + k >= size || !at(i + 7 + k, line, vertical));
        if (lightBefore || lightAfter) score += 40;
      }
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y][x]) dark++;
      if (x < size - 1 && y < size - 1) {
        const color = modules[y][x];
        if (color === modules[y][x + 1] && color === modules[y + 1][x] && color === modules[y + 1][x + 1]) score += 3;
      }
    }
  }
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

export interface QrOptions {
  errorCorrection?: QrErrorCorrection;
  /** Fixed mask 0–7; by default the mask with the lowest penalty is chosen. */
  mask?: number;
}

/**
 * Encodes `text` as UTF-8 bytes. Returns the module matrix (true = dark) without the quiet
 * zone, or throws RangeError when the text does not fit version 40.
 */
export function encodeQr(text: string, options: QrOptions = {}): boolean[][] {
  const ecl = options.errorCorrection ?? "M";
  const bytes = Array.from(new TextEncoder().encode(text));
  let version = 1;
  for (; version <= 40; version++) {
    const countBits = version <= 9 ? 8 : 16;
    if (bytes.length < 2 ** countBits && 4 + countBits + bytes.length * 8 <= dataCodewords(version, ecl) * 8) break;
  }
  if (version > 40) throw new RangeError("Text is too long for a QR code");

  const bits: number[] = [];
  const append = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  append(0b0100, 4);
  append(bytes.length, version <= 9 ? 8 : 16);
  bytes.forEach((byte) => append(byte, 8));
  const capacity = dataCodewords(version, ecl) * 8;
  append(0, Math.min(4, capacity - bits.length));
  append(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) append(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));

  const matrix = new Matrix(version);
  drawFunctionPatterns(matrix, ecl);
  drawCodewords(matrix, withErrorCorrection(data, version, ecl));

  let mask = options.mask;
  if (mask === undefined) {
    let best = Infinity;
    for (let candidate = 0; candidate < 8; candidate++) {
      applyMask(matrix, candidate);
      drawFormatBits(matrix, ecl, candidate);
      const score = penalty(matrix.modules);
      if (score < best) {
        best = score;
        mask = candidate;
      }
      applyMask(matrix, candidate); // XOR again to undo
    }
  }
  applyMask(matrix, mask as number);
  drawFormatBits(matrix, ecl, mask as number);
  return matrix.modules;
}

/** SVG path data (one unit per module) for the dark modules, shifted by `border` modules. */
export function qrPath(modules: boolean[][], border = 4): string {
  let path = "";
  modules.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) path += `M${x + border} ${y + border}h1v1h-1z`;
    });
  });
  return path;
}
