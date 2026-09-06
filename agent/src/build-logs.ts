import { spawn } from "node:child_process";
import type { AgentBuildLogBatch, BuildLogMessage, BuildLogStage } from "./protocol.js";

/**
 * A build emits its output through this callback. `buildApp` never awaits it: shipping build logs
 * must not be able to slow down or fail a build, so the publisher buffers and flushes on its own.
 */
export type BuildLogEmitter = (entry: BuildLogMessage) => void;

export const BUILD_LOG_FLUSH_INTERVAL_MS = 1_000;
export const BUILD_LOG_FLUSH_BATCH_SIZE = 200;
/**
 * A source build of a language runtime emits hundreds of thousands of lines. The control plane
 * keeps every accepted entry in a Redis list for seven days, so the agent caps what it forwards
 * and says so in the stream rather than letting one build fill the log store.
 */
export const BUILD_LOG_MAX_ENTRIES = 20_000;
export const BUILD_LOG_MAX_LINE_LENGTH = 4_000;
const BUILD_LOG_TRUNCATION_SUFFIX = "… [line truncated]";

export function truncateBuildLogLine(
  line: string,
  maxLength: number = BUILD_LOG_MAX_LINE_LENGTH
): string {
  if (line.length <= maxLength) {
    return line;
  }
  return `${line.slice(0, maxLength)}${BUILD_LOG_TRUNCATION_SUFFIX}`;
}

export interface BuildLogPublisher {
  emit: BuildLogEmitter;
  /** Flushes everything buffered and stops the timer. Never throws. */
  close(): Promise<void>;
}

export interface CreateBuildLogPublisherOptions {
  deploymentId: string;
  send: (batch: AgentBuildLogBatch) => Promise<unknown>;
  onSendError?: (error: unknown) => void;
  flushIntervalMs?: number;
  flushBatchSize?: number;
  maxEntries?: number;
  maxLineLength?: number;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  clearScheduled?: (timer: unknown) => void;
}

/**
 * Buffers build log entries and ships them to `/api/agent/logs/build` in batches. Delivery is
 * best-effort in both directions: a failed flush drops its batch instead of retrying, because a
 * build that succeeded must not fail over its logs, and a stalled control plane must not stall
 * the build.
 */
export function createBuildLogPublisher(
  options: CreateBuildLogPublisherOptions
): BuildLogPublisher {
  const flushIntervalMs = options.flushIntervalMs ?? BUILD_LOG_FLUSH_INTERVAL_MS;
  const flushBatchSize = options.flushBatchSize ?? BUILD_LOG_FLUSH_BATCH_SIZE;
  const maxEntries = options.maxEntries ?? BUILD_LOG_MAX_ENTRIES;
  const maxLineLength = options.maxLineLength ?? BUILD_LOG_MAX_LINE_LENGTH;
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearScheduled =
    options.clearScheduled ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));

  let buffer: BuildLogMessage[] = [];
  let emitted = 0;
  let capacityNoticeSent = false;
  let closed = false;
  let timer: unknown = null;
  let inFlight: Promise<void> = Promise.resolve();

  const cancelTimer = (): void => {
    if (timer !== null) {
      clearScheduled(timer);
      timer = null;
    }
  };

  const flush = (): Promise<void> => {
    cancelTimer();
    if (buffer.length === 0) {
      return inFlight;
    }

    const entries = buffer;
    buffer = [];
    inFlight = inFlight
      .then(() => options.send({ deploymentId: options.deploymentId, entries }))
      .then(
        () => undefined,
        (error: unknown) => {
          options.onSendError?.(error);
        }
      );
    return inFlight;
  };

  const armTimer = (): void => {
    if (timer !== null || closed) {
      return;
    }
    timer = schedule(() => {
      timer = null;
      void flush();
    }, flushIntervalMs);
  };

  const push = (entry: BuildLogMessage): void => {
    buffer.push(entry);
    if (buffer.length >= flushBatchSize) {
      void flush();
      return;
    }
    armTimer();
  };

  return {
    emit(entry) {
      if (closed) {
        return;
      }

      if (emitted >= maxEntries) {
        if (!capacityNoticeSent) {
          capacityNoticeSent = true;
          push({
            type: "stderr",
            line: `[nouva] build log truncated after ${maxEntries} lines; the rest of this build's output is not retained`,
            timestamp: now(),
          });
        }
        // `exit` closes the stream for the dashboard, so it is always let through.
        if (entry.type !== "exit") {
          return;
        }
      }

      emitted += 1;
      push(
        typeof entry.line === "string"
          ? { ...entry, line: truncateBuildLogLine(entry.line, maxLineLength) }
          : entry
      );
    },
    async close() {
      if (closed) {
        await inFlight;
        return;
      }
      closed = true;
      await flush();
      await inFlight;
    },
  };
}

export function buildProgressEntry(
  stage: BuildLogStage,
  message: string,
  percent: number,
  timestamp: number = Date.now()
): BuildLogMessage {
  return { type: "progress", stage, message, percent, timestamp };
}

export interface StreamCommandOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
  /** Lines kept in memory for the caller (image digest extraction, error tails). */
  captureLimit?: number;
}

export interface StreamCommandResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

const DEFAULT_CAPTURE_LIMIT = 2_000;

/**
 * Splits a byte stream into lines as they arrive. BuildKit's plain progress writer emits one line
 * per step, so this is what turns a build into a live feed instead of a single blob at the end.
 */
export function createLineSplitter(onLine: (line: string) => void): {
  push(chunk: string): void;
  flush(): void;
} {
  let pending = "";

  return {
    push(chunk) {
      pending += chunk;
      let newlineIndex = pending.indexOf("\n");
      while (newlineIndex !== -1) {
        onLine(pending.slice(0, newlineIndex).replace(/\r$/, ""));
        pending = pending.slice(newlineIndex + 1);
        newlineIndex = pending.indexOf("\n");
      }
    },
    flush() {
      if (pending.length > 0) {
        onLine(pending.replace(/\r$/, ""));
        pending = "";
      }
    },
  };
}

/**
 * Runs a command, forwarding each output line to `onLine` as it is produced and keeping a bounded
 * copy for the caller. Unlike `execFile` this neither buffers the whole build nor discards the
 * output when the command fails.
 */
export async function streamCommand(options: StreamCommandOptions): Promise<StreamCommandResult> {
  const captureLimit = options.captureLimit ?? DEFAULT_CAPTURE_LIMIT;
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  const capture = (lines: string[], line: string): void => {
    lines.push(line);
    if (lines.length > captureLimit) {
      lines.shift();
    }
  };

  return await new Promise<StreamCommandResult>((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutSplitter = createLineSplitter((line) => {
      capture(stdoutLines, line);
      options.onLine?.(line, "stdout");
    });
    const stderrSplitter = createLineSplitter((line) => {
      capture(stderrLines, line);
      options.onLine?.(line, "stderr");
    });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => stdoutSplitter.push(chunk));
    child.stderr?.on("data", (chunk: string) => stderrSplitter.push(chunk));

    child.on("error", (error) => {
      stdoutSplitter.flush();
      stderrSplitter.flush();
      reject(error);
    });

    child.on("close", (code, signal) => {
      stdoutSplitter.flush();
      stderrSplitter.flush();
      resolve({
        exitCode: code ?? (signal ? -1 : 0),
        signal: signal ?? null,
        stdout: stdoutLines.join("\n"),
        stderr: stderrLines.join("\n"),
      });
    });
  });
}
