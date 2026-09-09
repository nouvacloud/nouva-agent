import { describe, expect, test } from "bun:test";
import {
  assertAppliedDockerResourceSettings,
  toDockerResourceSettings,
} from "./docker-resource-limits.js";

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

  test("keeps the no-swap default when no combined allowance is stored", () => {
    expect(
      toDockerResourceSettings({
        cpuMillicores: 250,
        memoryBytes: 128 * 1024 * 1024,
        pidsLimit: 256,
        policyVersion: 1,
      })
    ).toMatchObject({
      Memory: 128 * 1024 * 1024,
      MemorySwap: 128 * 1024 * 1024,
    });
  });

  test("treats a combined allowance equal to the memory limit as no swap", () => {
    expect(
      toDockerResourceSettings({
        cpuMillicores: 250,
        memoryBytes: 128 * 1024 * 1024,
        memoryAndSwapBytes: 128 * 1024 * 1024,
        pidsLimit: 256,
        policyVersion: 1,
      })
    ).toMatchObject({
      Memory: 128 * 1024 * 1024,
      MemorySwap: 128 * 1024 * 1024,
    });
  });

  test("passes a bounded allowance above the memory limit to MemorySwap", () => {
    expect(
      toDockerResourceSettings({
        cpuMillicores: 250,
        memoryBytes: 128 * 1024 * 1024,
        memoryAndSwapBytes: 512 * 1024 * 1024,
        pidsLimit: 256,
        policyVersion: 1,
      })
    ).toEqual({
      NanoCpus: 250_000_000,
      Memory: 128 * 1024 * 1024,
      MemorySwap: 512 * 1024 * 1024,
      PidsLimit: 256,
    });
  });

  test("never asks Docker for unlimited swap", () => {
    expect(
      toDockerResourceSettings({
        cpuMillicores: 250,
        memoryBytes: 128 * 1024 * 1024,
        memoryAndSwapBytes: 512 * 1024 * 1024,
        pidsLimit: 256,
        policyVersion: 1,
      }).MemorySwap
    ).toBeGreaterThan(0);
  });

  const invalidCases: Array<{
    name: string;
    input: unknown;
    error: string;
  }> = [
    {
      name: "a combined allowance below the memory limit",
      input: {
        cpuMillicores: 250,
        memoryBytes: 128 * 1024 * 1024,
        memoryAndSwapBytes: 64 * 1024 * 1024,
        pidsLimit: 256,
      },
      error:
        "Invalid resourceLimits.memoryAndSwapBytes: 67108864 is below the 134217728 byte memory limit it must include",
    },
    {
      name: "a fractional combined allowance",
      input: {
        cpuMillicores: 250,
        memoryBytes: 1024,
        memoryAndSwapBytes: 2048.5,
        pidsLimit: 256,
      },
      error:
        "Invalid resourceLimits.memoryAndSwapBytes: expected a positive integer number of bytes",
    },
    {
      name: "a negative combined allowance",
      input: { cpuMillicores: 250, memoryBytes: 1024, memoryAndSwapBytes: -1, pidsLimit: 256 },
      error:
        "Invalid resourceLimits.memoryAndSwapBytes: expected a positive integer number of bytes",
    },
    {
      name: "an unlimited combined allowance",
      input: { cpuMillicores: 250, memoryBytes: 1024, memoryAndSwapBytes: null, pidsLimit: 256 },
      error:
        "Invalid resourceLimits.memoryAndSwapBytes: expected a positive integer number of bytes",
    },
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

describe("assertAppliedDockerResourceSettings", () => {
  const requested = {
    NanoCpus: 250_000_000,
    Memory: 128 * 1024 * 1024,
    MemorySwap: 512 * 1024 * 1024,
    PidsLimit: 256,
  };

  test("accepts a container that reports back every requested setting", () => {
    expect(() =>
      assertAppliedDockerResourceSettings({
        containerId: "ctr_1",
        requested,
        applied: { ...requested },
      })
    ).not.toThrow();
  });

  test("reports an allowance the daemon dropped back to the memory limit", () => {
    expect(() =>
      assertAppliedDockerResourceSettings({
        containerId: "ctr_1",
        requested,
        applied: { ...requested, MemorySwap: 128 * 1024 * 1024 },
      })
    ).toThrow(
      "Container ctr_1 did not apply the requested resource limits: MemorySwap 134217728 (expected 536870912)"
    );
  });

  test("reports a host config the daemon did not return at all", () => {
    expect(() =>
      assertAppliedDockerResourceSettings({
        containerId: "ctr_1",
        requested,
        applied: undefined,
      })
    ).toThrow("NanoCpus unset (expected 250000000)");
  });
});
