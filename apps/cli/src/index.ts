import { resolve } from "node:path";
import { loadEchoConfig, saveEchoConfig } from "@echo/config";
import { Command } from "commander";

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

program.parse();
