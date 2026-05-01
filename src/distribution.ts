import crypto from "node:crypto";
import path from "node:path";

export interface ReleaseArtifact {
  name: string;
  sha256: string;
  size?: number;
}

export interface HomebrewFormulaOptions {
  className?: string;
  packageName?: string;
  version: string;
  repo: string;
  description: string;
  homepage: string;
  license: string;
  artifact: ReleaseArtifact;
}

export type RuntimeArchiveFormat = "tar" | "zip";

export function sha256Hex(input: Buffer | string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function releaseArtifactName(version: string, platform: string, arch: string, extension: "tar.gz" | "zip"): string {
  return `kbx-v${version}-${platform}-${arch}.${extension}`;
}

export function checksumsText(artifacts: ReleaseArtifact[]): string {
  return [...artifacts]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((artifact) => `${artifact.sha256}  ${artifact.name}`)
    .join("\n") + "\n";
}

export function parseChecksumsText(value: string): ReleaseArtifact[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
      if (!match) {
        throw new Error(`Invalid checksum line: ${line}`);
      }
      return {
        sha256: match[1]!.toLowerCase(),
        name: path.basename(match[2]!)
      };
    });
}

export function archiveRootName(name: string): string {
  if (name.endsWith(".tar.gz")) {
    return name.slice(0, -".tar.gz".length);
  }
  if (name.endsWith(".tgz")) {
    return name.slice(0, -".tgz".length);
  }
  return name.replace(/\.[^.]+$/, "");
}

export function runtimeArchiveFormat(name: string): RuntimeArchiveFormat | undefined {
  if (name.endsWith(".zip")) {
    return "zip";
  }
  if (name.endsWith(".tar.gz") || name.endsWith(".tgz")) {
    return "tar";
  }
  return undefined;
}

export function requiredRuntimeArchiveEntries(name: string): string[] {
  const root = archiveRootName(name);
  const launcher = name.endsWith(".zip") ? `${root}/bin/kbx.cmd` : `${root}/bin/kbx`;
  return [
    `${root}/package.json`,
    `${root}/dist/cli.mjs`,
    `${root}/node_modules/`,
    `${root}/support/node/`,
    launcher
  ];
}

export function missingRuntimeArchiveEntries(name: string, entries: string[]): string[] {
  return requiredRuntimeArchiveEntries(name).filter((entry) => !hasArchiveEntry(entries, entry));
}

export function generateHomebrewFormula(options: HomebrewFormulaOptions): string {
  const className = options.className ?? "Kbx";
  const packageName = options.packageName ?? "kbx";
  const url = `https://github.com/${options.repo}/releases/download/v${options.version}/${options.artifact.name}`;

  return `class ${className} < Formula
  desc "${escapeRuby(options.description)}"
  homepage "${escapeRuby(options.homepage)}"
  url "${escapeRuby(url)}"
  sha256 "${options.artifact.sha256}"
  license "${escapeRuby(options.license)}"

  def install
    libexec.install Dir["*"]
    bin.install_symlink libexec/"bin/${packageName}" => "${packageName}"
  end

  test do
    assert_match "${options.version}", shell_output("#{bin}/${packageName} --version")
  end
end
`;
}

function escapeRuby(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

function hasArchiveEntry(entries: string[], required: string): boolean {
  return required.endsWith("/")
    ? entries.some((entry) => entry === required || entry.startsWith(required))
    : entries.includes(required);
}
