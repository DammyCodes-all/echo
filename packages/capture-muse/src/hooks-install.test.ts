import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MUSE_HOOK_EVENTS } from "@echo/capture-muse";
import { describe, expect, it } from "vitest";
import { installMuseHooks } from "./hooks-install";

function paths() {
  const dir = mkdtempSync(join(tmpdir(), "echo-hooks-install-"));
  return { dir, settings: join(dir, "settings.json"), cliBin: join(dir, "echo-cli") };
}

describe("installMuseHooks", () => {
  it("installs all 19 events, preserves unrelated hooks, and is idempotent", () => {
    const { settings, cliBin } = paths();
    writeFileSync(
      settings,
      `${JSON.stringify({ theme: "dark", hooks: { PreToolUse: [{ type: "command", command: "my-linter", timeout: 10 }] } }, null, 2)}\n`,
    );
    const first = installMuseHooks({ settingsPath: settings, cliBin });
    expect(first.changed).toBe(true);
    expect(first.eventsInstalled).toHaveLength(19);
    expect(first.backupPath).toBeTypeOf("string");

    const stored = JSON.parse(readFileSync(settings, "utf8")) as {
      theme: string;
      hooks: Record<string, Array<{ command: string }>>;
    };
    expect(stored.theme).toBe("dark");
    for (const event of MUSE_HOOK_EVENTS) {
      const entries = stored.hooks[event] ?? [];
      expect(entries.some((entry) => entry.command === `"${cliBin}" hook muse ${event}`)).toBe(
        true,
      );
    }
    // Unrelated entry keeps its position first.
    expect(stored.hooks.PreToolUse?.[0]?.command).toBe("my-linter");
    expect(stored.hooks.PreToolUse).toHaveLength(2);

    const before = readFileSync(settings, "utf8");
    const second = installMuseHooks({ settingsPath: settings, cliBin });
    expect(second.changed).toBe(false);
    expect(readFileSync(settings, "utf8")).toBe(before);
  });

  it("creates a fresh settings file without a backup", () => {
    const { settings, cliBin } = paths();
    const result = installMuseHooks({ settingsPath: settings, cliBin });
    expect(result.changed).toBe(true);
    expect(result.backupPath).toBeNull();
    const stored = JSON.parse(readFileSync(settings, "utf8")) as { hooks: Record<string, unknown> };
    expect(Object.keys(stored.hooks)).toHaveLength(19);
  });

  it("refuses to write on unparseable JSON", () => {
    const { settings, cliBin } = paths();
    writeFileSync(settings, "{oops");
    expect(() => installMuseHooks({ settingsPath: settings, cliBin })).toThrow(/unparseable/);
    expect(readFileSync(settings, "utf8")).toBe("{oops");
  });

  it("backs up once and replaces only stale Echo entries", () => {
    const { dir, settings, cliBin } = paths();
    const oldBin = join(dir, "old-echo-cli");
    writeFileSync(
      settings,
      `${JSON.stringify({ hooks: { PreToolUse: [{ type: "command", command: `"${oldBin}" hook muse PreToolUse`, timeout: 5 }] } }, null, 2)}\n`,
    );
    const first = installMuseHooks({ settingsPath: settings, cliBin });
    expect(first.backupPath).toBeTypeOf("string");
    expect(String(first.backupPath)).toContain(".echo-backup-");
    expect(statSync(String(first.backupPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(String(first.backupPath), "utf8"))).toMatchObject({
      hooks: { PreToolUse: [{ command: `"${oldBin}" hook muse PreToolUse` }] },
    });

    // Remove one Echo entry by hand; the next run repairs it without a second backup.
    const stored = JSON.parse(readFileSync(settings, "utf8")) as {
      hooks: Record<string, unknown[]>;
    };
    stored.hooks.SessionStart = [];
    writeFileSync(settings, `${JSON.stringify(stored, null, 2)}\n`);
    chmodSync(settings, 0o600);
    const second = installMuseHooks({ settingsPath: settings, cliBin });
    expect(second.changed).toBe(true);
    expect(second.backupPath).toBe(first.backupPath);
    const repaired = JSON.parse(readFileSync(settings, "utf8")) as {
      hooks: Record<string, Array<{ command: string }>>;
    };
    expect(
      repaired.hooks.PreToolUse?.some(
        (entry) => entry.command === `"${cliBin}" hook muse PreToolUse`,
      ),
    ).toBe(true);
    expect(repaired.hooks.PreToolUse?.some((entry) => entry.command.includes(oldBin))).toBe(false);
    expect(
      repaired.hooks.SessionStart?.some(
        (entry) => entry.command === `"${cliBin}" hook muse SessionStart`,
      ),
    ).toBe(true);
  });

  it("leaves the settings file permissions alone and locks down only the backup", () => {
    const { settings, cliBin } = paths();
    writeFileSync(settings, `${JSON.stringify({ hooks: {} }, null, 2)}\n`, { mode: 0o644 });
    chmodSync(settings, 0o644);
    const result = installMuseHooks({ settingsPath: settings, cliBin });
    expect(result.changed).toBe(true);
    expect(statSync(settings).mode & 0o777).toBe(0o644);
    expect(result.backupPath).toBeTypeOf("string");
    expect(statSync(String(result.backupPath)).mode & 0o777).toBe(0o600);
  });

  it("preserves hand-tuned fields on same-bin entries", () => {
    const { settings, cliBin } = paths();
    const hooks: Record<string, unknown[]> = {};
    for (const event of MUSE_HOOK_EVENTS) {
      hooks[event] = [
        {
          type: "command",
          command: `"${cliBin}" hook muse ${event}`,
          // Hand-tuned: the installer must not reset this to 5.
          timeout: event === "PreToolUse" ? 10 : 5,
        },
      ];
    }
    writeFileSync(settings, `${JSON.stringify({ hooks }, null, 2)}\n`);
    const before = readFileSync(settings, "utf8");
    const result = installMuseHooks({ settingsPath: settings, cliBin });
    expect(result.changed).toBe(false);
    expect(readFileSync(settings, "utf8")).toBe(before);
    const stored = JSON.parse(before) as { hooks: Record<string, Array<{ timeout: number }>> };
    expect(stored.hooks.PreToolUse?.[0]?.timeout).toBe(10);
  });

  it("carries extra handler keys from replaced stale entries", () => {
    const { dir, settings, cliBin } = paths();
    const oldBin = join(dir, "old-echo-cli");
    writeFileSync(
      settings,
      `${JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                type: "command",
                command: `"${oldBin}" hook muse PreToolUse`,
                timeout: 5,
                commandWindows: "pwsh -c ...",
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );
    installMuseHooks({ settingsPath: settings, cliBin });
    const stored = JSON.parse(readFileSync(settings, "utf8")) as {
      hooks: Record<string, Array<Record<string, unknown>>>;
    };
    expect(stored.hooks.PreToolUse).toHaveLength(1);
    const entry = stored.hooks.PreToolUse?.[0] as Record<string, unknown> | undefined;
    expect(entry?.command).toBe(`"${cliBin}" hook muse PreToolUse`);
    expect(entry?.timeout).toBe(5);
    expect(entry?.commandWindows).toBe("pwsh -c ...");
  });

  it("never treats a user entry that mentions hooks in prose as stale", () => {
    const { settings, cliBin } = paths();
    const prose = 'echo "my hook muse helper"';
    writeFileSync(
      settings,
      `${JSON.stringify({ hooks: { PreToolUse: [{ type: "command", command: prose, timeout: 3 }] } }, null, 2)}\n`,
    );
    const result = installMuseHooks({ settingsPath: settings, cliBin });
    expect(result.changed).toBe(true);
    const stored = JSON.parse(readFileSync(settings, "utf8")) as {
      hooks: Record<string, Array<{ command: string }>>;
    };
    // The user's entry survives untouched alongside the installed Echo entry.
    expect(stored.hooks.PreToolUse).toHaveLength(2);
    expect(stored.hooks.PreToolUse?.[0]?.command).toBe(prose);
    expect(stored.hooks.PreToolUse?.[1]?.command).toBe(`"${cliBin}" hook muse PreToolUse`);
  });
});
