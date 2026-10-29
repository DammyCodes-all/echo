import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildInventory, detectStack, inventoryRepo, languageForPath } from "./inventory";

function walkFile(path: string, absPath: string, size: number) {
  return {
    path,
    absPath,
    mode: "100644",
    size,
    mtimeNs: "0",
    symlink: false,
    linkTarget: null,
  };
}

describe("languageForPath", () => {
  it("maps code extensions and falls back to other", () => {
    expect(languageForPath("src/a.ts")).toBe("ts");
    expect(languageForPath("src/a.TSX")).toBe("tsx");
    expect(languageForPath("lib/a.mjs")).toBe("mjs");
    expect(languageForPath("package.json")).toBe("json");
    expect(languageForPath("README.md")).toBe("md");
    expect(languageForPath("Makefile")).toBe("other");
    expect(languageForPath("src/a.py")).toBe("other");
  });
});

describe("buildInventory", () => {
  it("hashes, sorts and fingerprints deterministically", () => {
    const bodies = new Map([
      ["/r/src/b.ts", Buffer.from("export const b = 1;\n")],
      ["/r/src/a.ts", Buffer.from("export const a = 1;\n")],
    ]);
    const input = {
      walk: {
        files: [walkFile("src/b.ts", "/r/src/b.ts", 21), walkFile("src/a.ts", "/r/src/a.ts", 21)],
        metadata: [],
      },
      readFile: (absPath: string) => {
        const body = bodies.get(absPath);
        if (!body) throw new Error(`missing ${absPath}`);
        return body;
      },
    };
    const first = buildInventory(input);
    const second = buildInventory(input);
    expect(first.files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(first.files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.filesHash).toBe(second.filesHash);
    expect(first.truncated).toBe(false);
    expect(first.skipped).toEqual([]);
  });

  it("skips symlinks, binaries, oversized, unreadable and metadata-only entries", () => {
    const big = { path: "big.ts", absPath: "/r/big.ts", size: 2_000_000 };
    const input = {
      walk: {
        files: [
          { ...walkFile("link.ts", "/r/link.ts", 3), symlink: true },
          walkFile("bin.ts", "/r/bin.ts", 4),
          { ...walkFile(big.path, big.absPath, big.size) },
          walkFile("gone.ts", "/r/gone.ts", 3),
          walkFile("ok.ts", "/r/ok.ts", 2),
        ],
        metadata: [{ path: ".env", size: 4, mtimeNs: "0", reason: "ignored" }],
      },
      readFile: (absPath: string) => {
        if (absPath === "/r/bin.ts") return Buffer.from([0x65, 0x00, 0x66]);
        if (absPath === "/r/ok.ts") return Buffer.from("ok");
        throw new Error("unreadable");
      },
    };
    const inventory = buildInventory(input);
    expect(inventory.files.map((f) => f.path)).toEqual(["ok.ts"]);
    expect(inventory.skipped).toEqual(
      expect.arrayContaining([
        { path: "bin.ts", reason: "binary" },
        { path: "big.ts", reason: "oversized" },
        { path: "gone.ts", reason: "unreadable" },
        { path: ".env", reason: "not-captured" },
      ]),
    );
  });
});

describe("inventoryRepo", () => {
  it("walks a real tree honoring .gitignore and node_modules", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-inv-"));
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(root, ".gitignore"), "ignored/\n");
    mkdirSync(join(root, "ignored"), { recursive: true });
    writeFileSync(join(root, "ignored", "x.ts"), "nope");
    writeFileSync(join(root, "node_modules", "dep", "x.js"), "nope");
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "package.json"), '{"name":"t"}\n');
    const inventory = inventoryRepo(root);
    expect(inventory.files.map((f) => f.path).sort()).toEqual([
      ".gitignore",
      "package.json",
      "src/a.ts",
    ]);
    expect(inventory.truncated).toBe(false);
  });
});

describe("detectStack", () => {
  it("detects frameworks from package.json deps and counts languages", () => {
    const inventory = {
      files: [
        { path: "src/a.ts", language: "ts" as const, size: 1, sha256: "a" },
        { path: "src/b.tsx", language: "tsx" as const, size: 1, sha256: "b" },
      ],
      filesHash: "h",
      skipped: [],
      truncated: false,
    };
    const stack = detectStack(inventory, [
      JSON.stringify({
        dependencies: { next: "15.0.0", "drizzle-orm": "0.40.0" },
        devDependencies: { typescript: "7.0.0" },
      }),
      "not json",
    ]);
    expect(stack.frameworks).toEqual(["Drizzle", "Next.js", "TypeScript"]);
    expect(stack.languages).toEqual({ ts: 1, tsx: 1 });
    expect(stack.fileCount).toBe(2);
  });
});
