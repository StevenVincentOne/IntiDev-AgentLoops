#!/usr/bin/env node
import { execSync } from "node:child_process";

execSync("git config core.hooksPath .githooks", {
  stdio: "inherit",
});

console.log("Configured local git hooks path to .githooks");
