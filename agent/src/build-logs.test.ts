import { describe, expect, test } from "bun:test";
import {
  createBuildLogPublisher,
  createLineSplitter,
  streamCommand,
  truncateBuildLogLine,
} from "./build-logs.js";
import type { AgentBuildLogBatch } from "./protocol.js";

function createRecordingSend() {
  const batches: AgentBuildLogBatch[] = [];
  return {
    batches,
    send: async (batch: AgentBuildLogBatch) => {
      batches.push(batch);
    },
  };
}

describe("createLineSplitter", () => {
  test("emits lines as chunks arrive and flushes a trailing partial line", () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => lines.push(line));

    splitter.push("#1 [internal] load ");
    splitter.push("build definition\n#2 resolve ");
    splitter.push("image\r\n#3 partial");

    expect(lines).toEqual(["#1 [internal] load build definition", "#2 resolve image"]);

    splitter.flush();
    expect(lines).toEqual([
      "#1 [internal] load build definition",
      "#2 resolve image",
      "#3 partial",
    ]);
  });
});

describe("truncateBuildLogLine", () => {
  test("marks lines it shortens and leaves shorter lines intact", () => {
    expect(truncateBuildLogLine("short", 10)).toBe("short");
    expect(truncateBuildLogLine("0123456789abc", 10)).toBe("0123456789… [line truncated]");
  });
});

describe("createBuildLogPublisher", () => {
  test("flushes once the batch size is reached", async () => {
    const recorder = createRecordingSend();
    const publisher = createBuildLogPublisher({
      deploymentId: "dep-1",
      send: recorder.send,
      flushBatchSize: 2,
      schedule: () => null,
      clearScheduled: () => undefined,
    });

    publisher.emit({ type: "stdout", line: "one", timestamp: 1 });
    expect(recorder.batches).toHaveLength(0);
    publisher.emit({ type: "stdout", line: "two", timestamp: 2 });
    await publisher.close();

    expect(recorder.batches).toHaveLength(1);
    expect(recorder.batches[0]?.deploymentId).toBe("dep-1");
    expect(recorder.batches[0]?.entries.map((entry) => entry.line)).toEqual(["one", "two"]);
  });

  test("close flushes what is still buffered", async () => {
    const recorder = createRecordingSend();
    const publisher = createBuildLogPublisher({
      deploymentId: "dep-2",
      send: recorder.send,
      flushBatchSize: 100,
      schedule: () => null,
      clearScheduled: () => undefined,
    });

    publisher.emit({ type: "stderr", line: "boom", timestamp: 1 });
    publisher.emit({ type: "exit", timestamp: 2, success: false, exitCode: 1 });
    await publisher.close();

    expect(recorder.batches).toHaveLength(1);
    expect(recorder.batches[0]?.entries).toHaveLength(2);
  });

  test("a failed flush is reported and never rejects the build", async () => {
    const errors: unknown[] = [];
    const publisher = createBuildLogPublisher({
      deploymentId: "dep-3",
      send: async () => {
        throw new Error("control plane unreachable");
      },
      onSendError: (error) => errors.push(error),
      flushBatchSize: 1,
      schedule: () => null,
      clearScheduled: () => undefined,
    });

    publisher.emit({ type: "stdout", line: "one", timestamp: 1 });
    await publisher.close();

    expect(errors).toHaveLength(1);
  });

  test("caps forwarded entries, says so once, and still delivers the exit entry", async () => {
    const recorder = createRecordingSend();
    const publisher = createBuildLogPublisher({
      deploymentId: "dep-4",
      send: recorder.send,
      flushBatchSize: 1_000,
      maxEntries: 2,
      now: () => 42,
      schedule: () => null,
      clearScheduled: () => undefined,
    });

    for (let index = 0; index < 5; index += 1) {
      publisher.emit({ type: "stdout", line: `line-${index}`, timestamp: index });
    }
    publisher.emit({ type: "exit", timestamp: 9, success: true, exitCode: 0 });
    await publisher.close();

    const entries = recorder.batches.flatMap((batch) => batch.entries);
    expect(entries.filter((entry) => entry.line?.includes("build log truncated"))).toHaveLength(1);
    expect(entries.filter((entry) => entry.type === "exit")).toHaveLength(1);
    expect(entries.filter((entry) => entry.line?.startsWith("line-"))).toHaveLength(2);
  });

  test("truncates over-long lines", async () => {
    const recorder = createRecordingSend();
    const publisher = createBuildLogPublisher({
      deploymentId: "dep-5",
      send: recorder.send,
      flushBatchSize: 1,
      maxLineLength: 5,
      schedule: () => null,
      clearScheduled: () => undefined,
    });

    publisher.emit({ type: "stdout", line: "abcdefghij", timestamp: 1 });
    await publisher.close();

    expect(recorder.batches[0]?.entries[0]?.line).toBe("abcde… [line truncated]");
  });
});

describe("streamCommand", () => {
  test("streams stdout and stderr lines and reports a zero exit", async () => {
    const seen: Array<[string, string]> = [];
    const result = await streamCommand({
      command: "sh",
      args: ["-c", "echo out; echo err >&2"],
      onLine: (line, stream) => seen.push([stream, line]),
    });

    expect(result.exitCode).toBe(0);
    expect(seen).toContainEqual(["stdout", "out"]);
    expect(seen).toContainEqual(["stderr", "err"]);
  });

  test("keeps the output of a failing command instead of discarding it", async () => {
    const result = await streamCommand({
      command: "sh",
      args: ["-c", "echo 'ERROR: package not found' >&2; exit 2"],
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("ERROR: package not found");
  });

  test("bounds how much output it retains", async () => {
    const result = await streamCommand({
      command: "sh",
      args: ["-c", "for i in $(seq 1 50); do echo line-$i; done"],
      captureLimit: 5,
    });

    expect(result.stdout.split("\n")).toHaveLength(5);
    expect(result.stdout).toContain("line-50");
    expect(result.stdout).not.toContain("line-1\n");
  });
});
