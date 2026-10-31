import { resolve } from "node:path";
import { importMuseSession } from "@echo/capture-muse";
import { loadEchoConfig, resolveEchoPaths, saveEchoConfig } from "@echo/config";
import { buildDemoBundle, resolveServerBin, verifyDemoBundle } from "@echo/demo";
import { Command } from "commander";
import { resolveDefaultWebDir, runDemoServe } from "./demo";
import { runDoctor } from "./doctor";
import { runHookCommand } from "./hook";
import { installMuseHooks, resolveEchoCliBin, resolveMuseSettingsPath } from "./hooks-install";
import { runRecordSession } from "./record";

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

program
  .command("record")
  .argument("[museArgs...]", "arguments passed through to muse")
  .option("--muse-bin <path>", "muse binary (default: muse)")
  .description("run an interactive muse session under Echo capture (exit code passes through)")
  // Wrapper flags (--muse-bin) are parsed; everything else passes through
  // untouched, so muse owns its flag parsing entirely.
  .allowUnknownOption()
  // A recorded session is a user-invoked foreground process: the child's
  // exit code is the result, and only a wrapper failure is exit 1.
  .action(async (museArgs: string[], options: { museBin?: string }) => {
    const result = await runRecordSession({ museBin: options.museBin, museArgs });
    if (!result.ok) {
      process.stderr.write(`record failed: ${result.diagnostic} (${result.detail})\n`);
      process.exitCode = 1;
      return;
    }
    if (result.signal) {
      process.stderr.write(`record ended on ${result.signal}\n`);
    }
    process.exitCode = result.exitCode;
  });

program
  .command("doctor")
  .description("check capture prerequisites and report Muse build drift")
  .option("--muse-bin <path>", "muse binary (default: muse)")
  .action((options: { museBin?: string }) => {
    try {
      const paths = resolveEchoPaths();
      const config = loadEchoConfig();
      const report = runDoctor({
        dataDir: paths.dataDir,
        projects: config.projects,
        museBin: options.museBin,
        configFile: paths.configFile,
      });
      for (const line of report.lines) process.stdout.write(`${line}\n`);
      for (const warning of report.warnings) process.stdout.write(`warning: ${warning}\n`);
    } catch (error) {
      process.stderr.write(
        `doctor failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  });

const demo = program.command("demo").description("baked read-only demo bundles");

demo
  .command("build")
  .description("bake sessions into a demo bundle (exports, scans, smoke-tests)")
  .option("--session <id>", "session to bake (repeat once for a second)", collectInto([]))
  .requiredOption("--out <dir>", "bundle output dir")
  .option("--data-dir <dir>", "Echo data dir (default: resolved)")
  .option("--web-dir <dir>", "built web assets (default: beside the CLI)")
  .option("--allow-secret <value>", "approved synthetic secret (repeatable)", collectInto([]))
  .option("--skip-smoke", "bake without running smoke tests")
  .action(
    async (options: {
      session: string[];
      out: string;
      dataDir?: string;
      webDir?: string;
      allowSecret: string[];
      skipSmoke?: boolean;
    }) => {
      try {
        const sessionIds = options.session ?? [];
        if (sessionIds.length === 0) {
          process.stderr.write("demo build: pass at least one --session <id>\n");
          process.exitCode = 1;
          return;
        }
        const webDir = options.webDir ?? resolveDefaultWebDir(process.argv[1]);
        if (!webDir) {
          process.stderr.write("demo build: cannot locate web assets; pass --web-dir\n");
          process.exitCode = 1;
          return;
        }
        const { meta } = buildDemoBundle({
          dataDir: options.dataDir ?? resolveEchoPaths().dataDir,
          sessionIds,
          outDir: options.out,
          webDir,
          allowSecrets: options.allowSecret,
          report: (step) => process.stdout.write(`demo build: ${step}\n`),
        });
        if (!options.skipSmoke) {
          const serverBin = resolveServerBin(process.env, process.argv[1]);
          if (!serverBin) {
            process.stderr.write("demo build: cannot locate the server bundle\n");
            process.exitCode = 1;
            return;
          }
          const results = await verifyDemoBundle({ serverBin, bundleDir: options.out });
          let failed = 0;
          for (const result of results) {
            process.stdout.write(
              `demo smoke: ${result.ok ? "ok" : "FAIL"} ${result.name}${result.detail ? ` (${result.detail})` : ""}\n`,
            );
            if (!result.ok) failed += 1;
          }
          if (failed > 0) {
            process.exitCode = 1;
            return;
          }
        }
        process.stdout.write(
          `demo baked: ${meta.sessions.length} session(s) -> ${options.out} (${meta.projectName})\n`,
        );
      } catch (error) {
        process.stderr.write(
          `demo build failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 1;
      }
    },
  );

demo
  .command("verify")
  .description("run the smoke tests against a baked bundle")
  .requiredOption("--dir <dir>", "bundle dir")
  .action(async (options: { dir: string }) => {
    try {
      const serverBin = resolveServerBin(process.env, process.argv[1]);
      if (!serverBin) {
        process.stderr.write("demo verify: cannot locate the server bundle\n");
        process.exitCode = 1;
        return;
      }
      const results = await verifyDemoBundle({ serverBin, bundleDir: options.dir });
      let failed = 0;
      for (const result of results) {
        process.stdout.write(
          `demo smoke: ${result.ok ? "ok" : "FAIL"} ${result.name}${result.detail ? ` (${result.detail})` : ""}\n`,
        );
        if (!result.ok) failed += 1;
      }
      if (failed > 0) process.exitCode = 1;
    } catch (error) {
      process.stderr.write(
        `demo verify failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  });

demo
  .command("serve")
  .description("serve a baked bundle locally (same profile as the hosted demo)")
  .requiredOption("--dir <dir>", "bundle dir")
  .option("--port <n>", "port (default: 4784)", "4784")
  .option("--host <addr>", "host (default: 127.0.0.1)", "127.0.0.1")
  .action(async (options: { dir: string; port: string; host: string }) => {
    const port = Number(options.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      process.stderr.write(`demo serve: invalid port ${options.port}\n`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = await runDemoServe({ bundleDir: options.dir, port, host: options.host });
  });

function collectInto(values: string[]): (value: string, previous: string[]) => string[] {
  return (value: string, previous: string[]) => [...(previous ?? values), value];
}

void program.parseAsync();
