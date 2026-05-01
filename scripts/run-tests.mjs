#!/usr/bin/env node
import { spawn } from "node:child_process";
import fg from "fast-glob";

const files = await fg(process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["test/**/*.test.ts"], {
  onlyFiles: true,
  unique: true
});

if (files.length === 0) {
  throw new Error("No test files found.");
}

const child = spawn(process.execPath, ["--import", "tsx", "--test", ...files], {
  stdio: "inherit",
  windowsHide: true
});

const code = await new Promise((resolve, reject) => {
  child.on("error", reject);
  child.on("close", resolve);
});
if (code !== 0) {
  process.exitCode = typeof code === "number" ? code : 1;
}
