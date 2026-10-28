import { resolve } from "node:path";
import { importMuseSession } from "@echo/capture-muse";
import { loadEchoConfig, resolveEchoPaths, saveEchoConfig } from "@echo/config";
import { Command } from "commander";
import { runHookCommand } from "./hook";
import { installMuseHooks, resolveEchoCliBin, resolveMuseSettingsPath } from "./hooks-install";

const program = new Command();

program
  .name("echo-cli")
  .description("Record, replay and verify a coding-agent session.")
  .version("0.1.0");

program
  .command("enable")
  .argument("<path>", "repository root to capture")
  .description("enable capture for a repository")
  .action((path: string) => {
    const config = loadEchoConfig();
    const root = resolve(path);
    if (!config.projects.includes(root)) config.projects.push(root);
    saveEchoConfig(config);
    process.stdout.write(`enabled ${root}\n`);
  });

program
  .command("disable")
  .argument("<path>", "repository root to stop capturing")
  .description("remove a repository from the capture allowlist")
  .action((path: string) => {
    const config = loadEchoConfig();
    const root = resolve(path);
    config.projects = config.projects.filter((candidate) => candidate !== root);
    saveEchoConfig(config);
    process.stdout.write(`disabled ${root}\n`);
  });

program
  .command("projects")
  .description("list enabled repositories")
  .action(() => {
    const config = loadEchoConfig();
    if (config.projects.length === 0) {
      process.stdout.write("no repositories enabled\n");
      return;
    }
    for (const project of config.projects) process.stdout.write(`${project}\n`);
  });

program
  .command("import")
  .argument("<session-id|path>", "Muse session id or path to a native session.jsonl")
  .description("import an existing Muse session (final state only, marks import_only)")
  .option("--project <path>", "working-tree root to attribute and snapshot")
  .option("--export <path>", "already-redacted export file to reconcile")
  .option("--sessions-dir <dir>", "override the Muse sessions directory")
  // Import is a user-invoked maintenance command: nonzero exits are visible
  // config/user errors, mirroring the enable/disable commands.
  .action(
    async (
      target: string,
      options: { project?: string; export?: string; sessionsDir?: string },
    ) => {
      try {
        const { dataDir } = resolveEchoPaths();
        const isPath = target.endsWith(".jsonl") || target.includes("/");
        const result = await importMuseSession({
          dataDir,
          sessionId: isPath ? undefined : target,
          path: isPath ? target : undefined,
          sessionsDir: options.sessionsDir,
          projectRoot: options.project ? resolve(options.project) : undefined,
          exportPath: options.export,
        });
        process.stdout.write(
          `imported ${result.sessionId} (${result.eventsAdded} events, snapshot ${result.snapshotCommit.slice(0, 12)}, import_only)\n`,
        );
      } catch (error) {
        process.stderr.write(
          `import failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 1;
      }
    },
  );

program
  .command("hook")
  .argument("<agent>", "agent the hook belongs to (muse)")
  .argument("<event>", "hook event name, e.g. PreToolUse")
  .description("ingest one agent hook event from stdin into the spool (never blocks)")
  // No exitOverride here: commander-level misuse (unknown command, missing
  // arg) surfaces a nonzero exit, which is a visible config bug, not a block
  // (only exit code 2 blocks). The hook action itself is total and silent.
  .action((agent: string, event: string) => {
    const result = runHookCommand({ agent, event });
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
  });

const hooks = program
  .command("hooks")
  .description("manage agent hook integration (idempotent, never blocks the agent)");

hooks
  .command("install")
  .description("install Echo command hooks into Muse settings (merges, backs up once)")
  .option("--settings-path <path>", "override the Muse settings.json path")
  .option("--cli-bin <path>", "override the absolute echo-cli binary path")
  // Installer failures are visible config errors, so a nonzero exit is
  // correct here. This is unrelated to the hook receiver's never-block
  // contract (only exit code 2 blocks), which stays exit-0.
  .action((options: { settingsPath?: string; cliBin?: string }) => {
    try {
      const settingsPath = options.settingsPath ?? resolveMuseSettingsPath();
      const cliBin = options.cliBin ?? resolveEchoCliBin();
      const result = installMuseHooks({ settingsPath, cliBin });
      if (result.changed) {
        process.stdout.write(
          `hooks installed: ${result.eventsInstalled.length} events -> ${result.settingsPath}\n`,
        );
      } else {
        process.stdout.write(`hooks already installed: ${result.settingsPath}\n`);
      }
      if (result.backupPath) process.stdout.write(`backup: ${result.backupPath}\n`);
    } catch (error) {
      process.stderr.write(
        `hooks install failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  });

void program.parseAsync();
