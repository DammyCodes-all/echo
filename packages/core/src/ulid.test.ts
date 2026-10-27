import { describe, expect, it } from "vitest";
import { decodeUlidTime, ulid } from "./ulid";

describe("ulid", () => {
  it("produces 26-character Crockford base32 ids", () => {
    const id = ulid();
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
  });

  it("round-trips the timestamp", () => {
    const now = 1793160000000;
    expect(decodeUlidTime(ulid(now))).toBe(now);
  });

  it("generates distinct ids within the same millisecond", () => {
    const now = 1793160000000;
    const ids = new Set(Array.from({ length: 100 }, () => ulid(now)));
    expect(ids.size).toBe(100);
  });
});
