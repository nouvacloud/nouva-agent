import { describe, expect, test } from "bun:test";
import {
  calculateDiskSafetyReserveBytes,
  GIBIBYTE,
  resolveDockerRootHostPath,
} from "./storage-metrics.js";

describe("Docker storage filesystem discovery", () => {
  test("maps Docker's root directory into the mounted host filesystem", () => {
    expect(resolveDockerRootHostPath("/var/lib/docker")).toBe("/hostfs/var/lib/docker");
  });

  test("rejects missing and relative Docker root directories", () => {
    expect(() => resolveDockerRootHostPath(null)).toThrow();
    expect(() => resolveDockerRootHostPath("var/lib/docker")).toThrow();
  });

  test("uses the larger of 5 GiB and five percent for disk safety", () => {
    expect(calculateDiskSafetyReserveBytes(40 * GIBIBYTE)).toBe(5 * GIBIBYTE);
    expect(calculateDiskSafetyReserveBytes(200 * GIBIBYTE)).toBe(10 * GIBIBYTE);
  });
});
