#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const directory = process.argv[2] ?? "dist/artifacts";
const output = process.argv[3] ?? path.join(directory, "checksums.txt");
const names = (await readdir(directory))
  .filter((name) => /\.(?:tgz|tar\.gz|zip|exe)$/i.test(name))
  .sort();

const lines = [];
for (const name of names) {
  const data = await readFile(path.join(directory, name));
  lines.push(`${createHash("sha256").update(data).digest("hex")}  ${name}`);
}

await writeFile(output, `${lines.join("\n")}\n`, "utf8");
console.log(`Wrote ${output}`);
