import { describe, expect, it } from "vitest";
import { parseAnswer } from "./ask-answer";

// Captured from a real answered thread: intro paragraph plus `*` bullets
// carrying [En] source tokens. The panel rendered all of it literally.
const CAPTURED =
  'From the evidence provided, the following were noted as could break / to avoid breaking:\n\n* Agent stated it was looking at session screens to see "what\'s breaking" [E2].\n* Agent stated design work to "avoid breaking the gate" [E3].\n* Agent stated evaluating refactoring to "avoid breaking a protected import" [E4].\n* Observed note: per-pair grouping "could still emit ~80 changes for a long session" [E1].\n';

const IDS = ["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8"];

describe("parseAnswer", () => {
  it("renders the captured answer as a paragraph plus a four-item list", () => {
    const blocks = parseAnswer(CAPTURED, IDS);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.kind).toBe("paragraph");
    expect(blocks[1]).toMatchObject({ kind: "list", ordered: false });
    if (blocks[1]?.kind === "list") expect(blocks[1].items).toHaveLength(4);
  });

  it("turns [En] tokens into source spans at the evidence position", () => {
    const blocks = parseAnswer(CAPTURED, IDS);
    const list = blocks[1];
    if (list?.kind !== "list") throw new Error("expected the list block");
    // [E2] sits in the first bullet and E2 is second in the evidence order.
    expect(list.items[0]).toContainEqual({ kind: "source", token: "E2", position: 2 });
    expect(list.items[3]).toContainEqual({ kind: "source", token: "E1", position: 1 });
  });

  it("keeps unknown tokens as literal text instead of dropping them", () => {
    const blocks = parseAnswer("A claim about nothing [E9].", IDS);
    expect(blocks).toHaveLength(1);
    const first = blocks[0];
    if (first?.kind !== "paragraph") throw new Error("expected the paragraph block");
    expect(first.spans).toContainEqual({ kind: "text", text: "A claim about nothing [E9]." });
  });

  it("groups numbered lines into an ordered list", () => {
    const blocks = parseAnswer("Two steps:\n\n1. First thing\n2. Second thing\n", IDS);
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toMatchObject({ kind: "list", ordered: true });
  });

  it("leaves plain prose as one paragraph", () => {
    const blocks = parseAnswer("Just a sentence, no markdown.", IDS);
    expect(blocks).toEqual([
      { kind: "paragraph", spans: [{ kind: "text", text: "Just a sentence, no markdown." }] },
    ]);
  });
});
