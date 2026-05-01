import assert from "node:assert/strict";
import test from "node:test";
import {
  archiveRootName,
  checksumsText,
  expandReleaseCommand,
  generateHomebrewFormula,
  missingRuntimeArchiveEntries,
  parseReleaseCommandLine,
  parseChecksumsText,
  releaseArtifactName,
  requiredRuntimeArchiveEntries,
  runtimeArchiveFormat,
  sha256Hex
} from "../src/distribution";

test("releaseArtifactName includes version, platform, arch, and extension", () => {
  assert.equal(releaseArtifactName("0.2.0", "darwin", "arm64", "tar.gz"), "kbx-v0.2.0-darwin-arm64.tar.gz");
});

test("checksums text round-trips release artifacts", () => {
  const artifacts = [
    { name: "kbx-v0.2.0-linux-x64.tar.gz", sha256: sha256Hex("linux") },
    { name: "kbx-v0.2.0-win32-x64.zip", sha256: sha256Hex("windows") }
  ];

  assert.deepEqual(parseChecksumsText(checksumsText(artifacts)), artifacts);
});

test("archiveRootName strips compound release extensions", () => {
  assert.equal(archiveRootName("kbx-v0.2.0-darwin-arm64.tar.gz"), "kbx-v0.2.0-darwin-arm64");
  assert.equal(archiveRootName("kbx-v0.2.0-linux-x64.tgz"), "kbx-v0.2.0-linux-x64");
  assert.equal(archiveRootName("kbx-v0.2.0-win32-x64.zip"), "kbx-v0.2.0-win32-x64");
});

test("runtime archive requirements include platform launcher", () => {
  assert.ok(requiredRuntimeArchiveEntries("kbx-v0.2.0-win32-x64.zip").includes("kbx-v0.2.0-win32-x64/bin/kbx.cmd"));
  assert.ok(requiredRuntimeArchiveEntries("kbx-v0.2.0-darwin-arm64.tar.gz").includes("kbx-v0.2.0-darwin-arm64/bin/kbx"));
});

test("runtimeArchiveFormat recognizes supported release archive types", () => {
  assert.equal(runtimeArchiveFormat("kbx-v0.2.0-win32-x64.zip"), "zip");
  assert.equal(runtimeArchiveFormat("kbx-v0.2.0-darwin-arm64.tar.gz"), "tar");
  assert.equal(runtimeArchiveFormat("kbx-v0.2.0-linux-x64.tgz"), "tar");
  assert.equal(runtimeArchiveFormat("kbx-v0.2.0-win32-x64.exe"), undefined);
});

test("parseReleaseCommandLine preserves quoted arguments", () => {
  assert.deepEqual(parseReleaseCommandLine('codesign --sign "Developer ID Application: Example" "{file}"'), [
    "codesign",
    "--sign",
    "Developer ID Application: Example",
    "{file}"
  ]);
});

test("expandReleaseCommand replaces signing placeholders after parsing", () => {
  assert.deepEqual(expandReleaseCommand('xcrun notarytool submit "{artifact}" --keychain-profile "{profile}"', {
    artifact: "dist/artifacts/kbx-v0.2.0-darwin-arm64.tar.gz",
    profile: "kbx-release"
  }), [
    "xcrun",
    "notarytool",
    "submit",
    "dist/artifacts/kbx-v0.2.0-darwin-arm64.tar.gz",
    "--keychain-profile",
    "kbx-release"
  ]);
});

test("parseReleaseCommandLine rejects unterminated quotes", () => {
  assert.throws(() => parseReleaseCommandLine('codesign --sign "missing'), /Unterminated quote/);
});

test("missingRuntimeArchiveEntries rejects archives without bundled runtime payload", () => {
  const missing = missingRuntimeArchiveEntries("kbx-v0.2.0-darwin-arm64.tar.gz", [
    "kbx-v0.2.0-darwin-arm64/package.json",
    "kbx-v0.2.0-darwin-arm64/dist/cli.mjs",
    "kbx-v0.2.0-darwin-arm64/bin/kbx"
  ]);

  assert.deepEqual(missing, [
    "kbx-v0.2.0-darwin-arm64/node_modules/",
    "kbx-v0.2.0-darwin-arm64/support/node/"
  ]);
});

test("missingRuntimeArchiveEntries accepts directory contents without explicit directory records", () => {
  assert.deepEqual(missingRuntimeArchiveEntries("kbx-v0.2.0-win32-x64.zip", [
    "kbx-v0.2.0-win32-x64/package.json",
    "kbx-v0.2.0-win32-x64/dist/cli.mjs",
    "kbx-v0.2.0-win32-x64/node_modules/better-sqlite3/package.json",
    "kbx-v0.2.0-win32-x64/support/node/node.exe",
    "kbx-v0.2.0-win32-x64/bin/kbx.cmd"
  ]), []);
});

test("generateHomebrewFormula points at a signed GitHub release artifact", () => {
  const formula = generateHomebrewFormula({
    version: "0.2.0",
    repo: "lord007tn/kbx",
    description: "Local-first knowledge base CLI",
    homepage: "https://github.com/lord007tn/kbx#readme",
    license: "MIT",
    artifact: {
      name: "kbx-v0.2.0-darwin-arm64.tar.gz",
      sha256: sha256Hex("archive")
    }
  });

  assert.match(formula, /class Kbx < Formula/);
  assert.match(formula, /releases\/download\/v0\.2\.0\/kbx-v0\.2\.0-darwin-arm64\.tar\.gz/);
  assert.match(formula, /sha256 "[a-f0-9]{64}"/);
  assert.match(formula, /assert_match "0\.2\.0"/);
});
