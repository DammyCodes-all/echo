import { describe, expect, it } from "vitest";
import { stableJson } from "./json";

describe("stableJson", () => {
  it("serializes object keys in sorted order at every depth", () => {
    expect(stableJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}',
    );
  });

  it("keeps array order and drops undefined like JSON.stringify", () => {
    expect(stableJson({ z: undefined, a: [undefined, 1] })).toBe('{"a":[null,1]}');
  });
});
