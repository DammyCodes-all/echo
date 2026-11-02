import { describe, expect, test } from "vitest";
import {
  FolderResolveResponseSchema,
  ProjectDisableRequestSchema,
  ProjectEnableRequestSchema,
  SettingsGetResponseSchema,
} from "./settings";

describe("settings contracts", () => {
  test("enable/disable requests trim and reject empty paths", () => {
    expect(ProjectEnableRequestSchema.safeParse({ path: "  /repo  " }).success).toBe(true);
    expect(ProjectEnableRequestSchema.safeParse({ path: "  " }).success).toBe(false);
    expect(ProjectDisableRequestSchema.safeParse({}).success).toBe(false);
  });

  test("settings response carries projects plus hook presence", () => {
    const parsed = SettingsGetResponseSchema.safeParse({
      projects: ["/repo"],
      hooks: {
        settingsPath: "/home/u/.muse/settings.json",
        totalEvents: 19,
        eventsInstalled: ["SessionStart"],
        installed: false,
      },
    });
    expect(parsed.success).toBe(true);
  });

  test("resolve response carries machine paths plus a cutoff flag", () => {
    const parsed = FolderResolveResponseSchema.safeParse({
      name: "echo",
      matches: ["/home/u/dev/echo"],
      truncated: false,
    });
    expect(parsed.success).toBe(true);
    expect(FolderResolveResponseSchema.safeParse({ name: "x" }).success).toBe(false);
  });
});
