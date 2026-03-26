import { describe, expect, test } from "bun:test";
import { parseDockerLogBuffer } from "./docker-api.js";

function encodeFrame(streamType: 1 | 2, payload: string): Buffer {
  const content = Buffer.from(payload, "utf8");
  const header = Buffer.alloc(8);
  header[0] = streamType;
  header.writeUInt32BE(content.length, 4);
  return Buffer.concat([header, content]);
}

describe("parseDockerLogBuffer", () => {
  test("parses multiplexed stdout and stderr log frames", () => {
    const raw = Buffer.concat([
      encodeFrame(1, "2026-03-26T12:00:00.000000000Z service ready\n"),
      encodeFrame(2, "2026-03-26T12:00:01.000000000Z failed to connect\n"),
    ]);

    expect(parseDockerLogBuffer(raw, true)).toEqual([
      {
        type: "stdout",
        timestamp: "2026-03-26T12:00:00.000000000Z",
        line: "service ready",
      },
      {
        type: "stderr",
        timestamp: "2026-03-26T12:00:01.000000000Z",
        line: "failed to connect",
      },
    ]);
  });

  test("falls back to plain stdout text when the payload is not multiplexed", () => {
    const raw = Buffer.from("first line\nsecond line\n", "utf8");

    expect(parseDockerLogBuffer(raw, false)).toEqual([
      {
        type: "stdout",
        timestamp: null,
        line: "first line",
      },
      {
        type: "stdout",
        timestamp: null,
        line: "second line",
      },
    ]);
  });
});
