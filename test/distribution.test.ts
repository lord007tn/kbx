import assert from "node:assert/strict";
import test from "node:test";
import { checksumsText, generateHomebrewFormula, parseChecksumsText, releaseArtifactName, sha256Hex } from "../src/distribution";

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
