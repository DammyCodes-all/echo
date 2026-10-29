import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EchoDb, listProjects, openEchoDb } from "@echo/db";
import { describe, expect, it } from "vitest";
import { ensureEnabledProjects } from "./enabled-projects";

function openTestDb(): EchoDb {
  const dir = mkdtempSync(join(tmpdir(), "echo-enabled-"));
  return openEchoDb(join(dir, "echo.sqlite"));
}

describe("ensureEnabledProjects", () => {
  it("materializes an enabled root with zero sessions", async () => {
    const db = openTestDb();
    const root = mkdtempSync(join(tmpdir(), "echo-proj-"));
    const ids = await ensureEnabledProjects(db, [root]);

    expect(ids).toHaveLength(1);
    expect(listProjects(db)).toHaveLength(1);
    expect(listProjects(db)[0]).toMatchObject({
      id: ids[0],
      sessionCount: 0,
      lastActivity: null,
    });
    db.close();
  });

  it("is idempotent and skips missing roots", async () => {
    const db = openTestDb();
    const root = mkdtempSync(join(tmpdir(), "echo-proj-"));
    await ensureEnabledProjects(db, [root, join(tmpdir(), "echo-no-such-dir-xyz")]);
    await ensureEnabledProjects(db, [root, root]);

    expect(listProjects(db)).toHaveLength(1);
    db.close();
  });
});
