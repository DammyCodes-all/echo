import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type EchoConfig, EchoConfigSchema } from "@echo/contracts";

const DEFAULT_OPENCODE_DB = ".local/share/opencode/opencode.db";

export interface EchoPaths {
  dataDir: string;
  configDir: string;
  configFile: string;
}

export function resolveEchoPaths(env: NodeJS.ProcessEnv = process.env): EchoPaths {
  const dataDir =
    env.ECHO_DATA_DIR ?? join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "echo");
  const configDir =
    env.ECHO_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "echo");
  return { dataDir, configDir, configFile: join(configDir, "config.json") };
}

export function loadEchoConfig(env: NodeJS.ProcessEnv = process.env): EchoConfig {
  const { configFile } = resolveEchoPaths(env);
  const raw = existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : {};
  const config = EchoConfigSchema.parse(raw);
  config.opencode_db ??= join(homedir(), DEFAULT_OPENCODE_DB);
  return config;
}

export function saveEchoConfig(config: EchoConfig, env: NodeJS.ProcessEnv = process.env): void {
  const { configFile, configDir } = resolveEchoPaths(env);
  mkdirSync(configDir, { recursive: true });
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
}
