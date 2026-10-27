const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;

function encodeTime(now: number): string {
  let out = "";
  let time = now;
  for (let i = 0; i < TIME_LENGTH; i++) {
    out = ENCODING[time % 32] + out;
    time = Math.floor(time / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  let byteIndex = 0;
  for (let i = 0; i < RANDOM_LENGTH; i++) {
    if (bits < 5) {
      // ten bytes feed exactly sixteen 5-bit groups; the fallback never fires
      acc = (acc << 8) | (bytes[byteIndex] ?? 0);
      byteIndex++;
      bits += 8;
    }
    out += ENCODING[(acc >> (bits - 5)) & 31];
    bits -= 5;
  }
  return out;
}

export function ulid(now: number = Date.now()): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return encodeTime(now) + encodeRandom(bytes);
}

export function decodeUlidTime(id: string): number {
  let time = 0;
  for (let i = 0; i < TIME_LENGTH; i++) {
    const char = id[i];
    if (char === undefined) throw new Error("ULID too short");
    const value = ENCODING.indexOf(char);
    if (value === -1) throw new Error(`invalid ULID character: ${char}`);
    time = time * 32 + value;
  }
  return time;
}
