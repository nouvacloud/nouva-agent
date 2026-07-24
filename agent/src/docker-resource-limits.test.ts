import { describe, expect, test } from "bun:test";
import { toDockerResourceSettings } from "./docker-resource-limits.js";

describe("toDockerResourceSettings", () => {
  test("translates complete effective limits and disables memory swap", () => {
    expect(
      toDockerResourceSettings({
        cpuMillicores: 2000,
        memoryBytes: 4 * 1024 * 1024 * 1024,
        pidsLimit: 512,
        policyVersion: 1,
      })
    ).toEqual({
      NanoCpus: 2_000_000_000,
      Memory: 4 * 1024 * 1024 * 1024,
      MemorySwap: 4 * 1024 * 1024 * 1024,
      PidsLimit: 512,
    });
  });

  const invalidCases: Array<{
    name: string;
    input: unknown;
    error: string;
  }> = [
    {
      name: "an empty object",
      input: {},
      error:
        "Invalid resourceLimits payload: expected complete effective CPU, memory, and PID limits",
    },
    {
      name: "a string cpu limit",
      input: { cpuMillicores: "1000", memoryBytes: 1024, pidsLimit: 256 },
      error:
        "Invalid resourceLimits.cpuMillicores: expected a positive integer number of millicores",
    },
    {
      name: "a fractional cpu limit",
      input: { cpuMillicores: 1.5, memoryBytes: 1024, pidsLimit: 256 },
      error:
        "Invalid resourceLimits.cpuMillicores: expected a positive integer number of millicores",
    },
    {
      name: "a zero cpu limit",
      input: { cpuMillicores: 0, memoryBytes: 1024, pidsLimit: 256 },
      error:
        "Invalid resourceLimits.cpuMillicores: expected a positive integer number of millicores",
    },
    {
      name: "a negative memory limit",
      input: { cpuMillicores: 250, memoryBytes: -1, pidsLimit: 256 },
      error: "Invalid resourceLimits.memoryBytes: expected a positive integer number of bytes",
    },
    {
      name: "an infinite memory limit",
      input: { cpuMillicores: 250, memoryBytes: Number.POSITIVE_INFINITY, pidsLimit: 256 },
      error: "Invalid resourceLimits.memoryBytes: expected a positive integer number of bytes",
    },
    {
      name: "a NaN memory limit",
      input: { cpuMillicores: 250, memoryBytes: Number.NaN, pidsLimit: 256 },
      error: "Invalid resourceLimits.memoryBytes: expected a positive integer number of bytes",
    },
  ];

  for (const invalidCase of invalidCases) {
    test(`rejects ${invalidCase.name}`, () => {
      expect(() => toDockerResourceSettings(invalidCase.input)).toThrow(invalidCase.error);
    });
  }

  test("rejects missing effective limits", () => {
    expect(() => toDockerResourceSettings(null)).toThrow(
      "Invalid resourceLimits payload: expected complete effective CPU, memory, and PID limits"
    );
    expect(() => toDockerResourceSettings({ cpuMillicores: 250, memoryBytes: 1024 })).toThrow(
      "Invalid resourceLimits payload: expected complete effective CPU, memory, and PID limits"
    );
  });
});
