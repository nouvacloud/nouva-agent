import { describe, expect, test } from "bun:test";
import { toDockerResourceSettings } from "./docker-resource-limits.js";

describe("toDockerResourceSettings", () => {
  test("returns no Docker limits for missing or null resource limits", () => {
    expect(toDockerResourceSettings(undefined)).toEqual({});
    expect(toDockerResourceSettings(null)).toEqual({});
  });

  test("translates CPU-only limits into Docker NanoCpus", () => {
    expect(
      toDockerResourceSettings({
        cpuMillicores: 750,
      })
    ).toEqual({
      NanoCpus: 750_000_000,
    });
  });

  test("translates memory-only limits into Docker Memory", () => {
    expect(
      toDockerResourceSettings({
        memoryBytes: 512 * 1024 * 1024,
      })
    ).toEqual({
      Memory: 512 * 1024 * 1024,
    });
  });

  test("translates CPU and memory limits together", () => {
    expect(
      toDockerResourceSettings({
        cpuMillicores: 2000,
        memoryBytes: 4 * 1024 * 1024 * 1024,
      })
    ).toEqual({
      NanoCpus: 2_000_000_000,
      Memory: 4 * 1024 * 1024 * 1024,
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
        "Invalid resourceLimits payload: provide cpuMillicores and/or memoryBytes, or null for unlimited",
    },
    {
      name: "a string cpu limit",
      input: { cpuMillicores: "1000" },
      error:
        "Invalid resourceLimits.cpuMillicores: expected a positive integer number of millicores",
    },
    {
      name: "a fractional cpu limit",
      input: { cpuMillicores: 1.5 },
      error:
        "Invalid resourceLimits.cpuMillicores: expected a positive integer number of millicores",
    },
    {
      name: "a zero cpu limit",
      input: { cpuMillicores: 0 },
      error:
        "Invalid resourceLimits.cpuMillicores: expected a positive integer number of millicores",
    },
    {
      name: "a negative memory limit",
      input: { memoryBytes: -1 },
      error: "Invalid resourceLimits.memoryBytes: expected a positive integer number of bytes",
    },
    {
      name: "an infinite memory limit",
      input: { memoryBytes: Number.POSITIVE_INFINITY },
      error: "Invalid resourceLimits.memoryBytes: expected a positive integer number of bytes",
    },
    {
      name: "a NaN memory limit",
      input: { memoryBytes: Number.NaN },
      error: "Invalid resourceLimits.memoryBytes: expected a positive integer number of bytes",
    },
  ];

  for (const invalidCase of invalidCases) {
    test(`rejects ${invalidCase.name}`, () => {
      expect(() => toDockerResourceSettings(invalidCase.input)).toThrow(invalidCase.error);
    });
  }
});
