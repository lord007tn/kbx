export function archiveRootName(name) {
  if (name.endsWith(".tar.gz")) {
    return name.slice(0, -".tar.gz".length);
  }
  if (name.endsWith(".tgz")) {
    return name.slice(0, -".tgz".length);
  }
  return name.replace(/\.[^.]+$/, "");
}

export function runtimeArchiveFormat(name) {
  if (name.endsWith(".zip")) {
    return "zip";
  }
  if (name.endsWith(".tar.gz") || name.endsWith(".tgz")) {
    return "tar";
  }
  return undefined;
}

export function requiredRuntimeArchiveEntries(name) {
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

export function missingRuntimeArchiveEntries(name, entries) {
  return requiredRuntimeArchiveEntries(name).filter((entry) => !hasArchiveEntry(entries, entry));
}

export function parseReleaseCommandLine(value) {
  const parts = [];
  let current = "";
  let quote;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];
    if (char === "\\" && next && (next === "\\" || next === "\"" || next === "'" || /\s/.test(next))) {
      current += next;
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (quote) {
    throw new Error("Unterminated quote in release command.");
  }
  if (current) {
    parts.push(current);
  }
  return parts;
}

export function expandReleaseCommand(value, replacements) {
  return parseReleaseCommandLine(value).map((part) => {
    let expanded = part;
    for (const [key, replacement] of Object.entries(replacements)) {
      expanded = expanded.replaceAll(`{${key}}`, replacement);
    }
    return expanded;
  });
}

function hasArchiveEntry(entries, required) {
  return required.endsWith("/")
    ? entries.some((entry) => entry === required || entry.startsWith(required))
    : entries.includes(required);
}
