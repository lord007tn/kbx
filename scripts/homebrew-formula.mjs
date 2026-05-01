#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const checksums = await readFile(process.argv[2] ?? "dist/artifacts/checksums.txt", "utf8");
const artifactName = process.argv[3] ?? `kbx-v${packageJson.version}-darwin-arm64.tar.gz`;
const checksum = checksums
  .split(/\r?\n/)
  .map((line) => line.trim())
  .find((line) => line.endsWith(`  ${artifactName}`))
  ?.split(/\s+/)[0];

if (!checksum) {
  throw new Error(`No checksum found for ${artifactName}`);
}

const repo = packageJson.repository?.url
  ?.replace(/^git\+/, "")
  .replace(/^https:\/\/github\.com\//, "")
  .replace(/\.git$/, "") ?? "lord007tn/kbx";
const output = process.argv[4] ?? "dist/homebrew/Formula/kbx.rb";
const formula = `class Kbx < Formula
  desc "${packageJson.description}"
  homepage "${packageJson.homepage}"
  url "https://github.com/${repo}/releases/download/v${packageJson.version}/${artifactName}"
  sha256 "${checksum}"
  license "${packageJson.license}"

  def install
    libexec.install Dir["*"]
    bin.install_symlink libexec/"bin/kbx" => "kbx"
  end

  test do
    assert_match "${packageJson.version}", shell_output("#{bin}/kbx --version")
  end
end
`;

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, formula, "utf8");
console.log(`Wrote ${output}`);
