import { Worker } from "node:worker_threads";

export interface TerminalProgressUpdate {
  phase: string;
  label: string;
  current?: number;
  total?: number;
  count?: number;
  detail?: string;
}

export interface TerminalProgress {
  update: (update: TerminalProgressUpdate) => void;
  finish: (message?: string) => void;
  error: (message?: string) => void;
  stop: () => Promise<void>;
}

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { writeSync } = require("node:fs");

const fd = workerData.fd ?? 2;
const startedAt = workerData.startedAt ?? Date.now();
const columns = Math.max(60, Math.min(workerData.columns ?? 100, 140));
const spinner = [".", "o", "O", "o"];
const reset = "\x1b[0m";
const dim = "\x1b[2m";
const green = "\x1b[32m";
const red = "\x1b[31m";
const cyan = "\x1b[36m";
const bold = "\x1b[1m";

let state = null;

function write(value) {
  try {
    writeSync(fd, value);
  } catch {
    // Ignore broken pipes or closed stdio during process shutdown.
  }
}

function elapsedFrame() {
  return Math.floor((Date.now() - startedAt) / 120);
}

function clip(value, max) {
  const compact = String(value ?? "").replace(/\s+/g, " ").trim();
  return compact.length > max ? compact.slice(0, Math.max(0, max - 3)) + "..." : compact;
}

function formatNumber(value) {
  return Number(value).toLocaleString();
}

function renderBar(percent) {
  const width = 24;
  const filled = Math.max(0, Math.min(width, Math.round(width * percent / 100)));
  return cyan + bold + "=".repeat(filled) + reset + dim + "-".repeat(width - filled) + reset;
}

function render() {
  if (!state) return;
  const glyph = spinner[elapsedFrame() % spinner.length] ?? ".";
  const detailBudget = Math.max(12, columns - 70);
  const detail = state.detail ? " " + dim + clip(state.detail, detailBudget) + reset : "";
  let line;
  if (typeof state.total === "number" && state.total > 0 && typeof state.current === "number") {
    const percent = Math.max(0, Math.min(100, Math.round(state.current / state.total * 100)));
    line = dim + "|" + reset + "  " + cyan + glyph + reset + " " + state.label + " " + renderBar(percent) + " " + percent + "% " + formatNumber(state.current) + "/" + formatNumber(state.total) + detail;
  } else if (typeof state.count === "number" && state.count > 0) {
    line = dim + "|" + reset + "  " + cyan + glyph + reset + " " + state.label + "... " + formatNumber(state.count) + detail;
  } else {
    line = dim + "|" + reset + "  " + cyan + glyph + reset + " " + state.label + "..." + detail;
  }
  write("\r\x1b[K" + line);
}

function finish(message, ok) {
  if (!state && !message) return;
  const label = message || state.label;
  const detail = state && state.detail ? " " + dim + clip(state.detail, Math.max(12, columns - 48)) + reset : "";
  write("\r\x1b[K" + dim + "|" + reset + "  " + (ok ? green : red) + (ok ? "+" : "x") + reset + " " + label + detail + "\n");
  state = null;
}

const timer = setInterval(render, 60);
timer.unref?.();

parentPort.on("message", (message) => {
  if (message.type === "update") {
    state = message.update;
    render();
  } else if (message.type === "finish-phase") {
    finish(undefined, true);
  } else if (message.type === "finish") {
    finish(message.message, true);
  } else if (message.type === "error") {
    finish(message.message || "Failed", false);
  } else if (message.type === "stop") {
    clearInterval(timer);
    finish(undefined, true);
    parentPort.postMessage({ type: "stopped" });
  }
});
`;

export function createTerminalProgress(): TerminalProgress | undefined {
  if (process.stderr.isTTY !== true) {
    return undefined;
  }

  let worker: Worker;
  try {
    worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        fd: typeof process.stderr.fd === "number" ? process.stderr.fd : 2,
        startedAt: Date.now(),
        columns: process.stderr.columns
      }
    });
  } catch {
    return undefined;
  }

  let lastPhase = "";
  let stopping: Promise<void> | null = null;

  const post = (message: unknown) => {
    try {
      worker.postMessage(message);
    } catch {
      // The worker may already be gone during process shutdown.
    }
  };

  return {
    update(update) {
      if (update.phase !== lastPhase && lastPhase) {
        post({ type: "finish-phase" });
      }
      lastPhase = update.phase;
      post({ type: "update", update });
    },
    finish(message) {
      post({ type: "finish", message });
      lastPhase = "";
    },
    error(message) {
      post({ type: "error", message });
      lastPhase = "";
    },
    stop() {
      if (stopping) {
        return stopping;
      }
      stopping = new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          worker.terminate().then(() => resolve(), () => resolve());
        }, 1000);
        worker.once("message", (message: { type?: string }) => {
          if (message.type === "stopped") {
            clearTimeout(timeout);
            worker.terminate().then(() => resolve(), () => resolve());
          }
        });
        post({ type: "stop" });
      });
      return stopping;
    }
  };
}
