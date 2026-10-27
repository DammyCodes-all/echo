#!/usr/bin/env node
import { Command } from "commander";

const program = new Command();

program
  .name("echo-cli")
  .description("Record, replay and verify a coding-agent session.")
  .version("0.1.0");

program.parse();
