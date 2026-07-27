import { describe, expect, mock, test } from "bun:test";
import { createVolumeMetricsCollector } from "./volume-metrics-loop.js";

describe("createVolumeMetricsCollector", () => {
  test("should reject overlapping collection attempts", async () => {
    let releaseReport: (() => void) | undefined;
    const report = mock(
      () =>
        new Promise<void>((resolve) => {
          releaseReport = resolve;
        })
    );
    const collector = createVolumeMetricsCollector(report);

    const first = collector.trigger();
    const overlapping = await collector.trigger();
    releaseReport?.();

    expect(overlapping).toBe(false);
    expect(await first).toBe(true);
    expect(report).toHaveBeenCalledTimes(1);
  });

  test("should stay active until the in-flight collection settles", async () => {
    let releaseReport: ((error?: Error) => void) | undefined;
    const report = mock(
      () =>
        new Promise<void>((resolve, reject) => {
          releaseReport = (error) => (error ? reject(error) : resolve());
        })
    );
    const collector = createVolumeMetricsCollector(report);
    const active = collector.trigger();

    expect(collector.isActive()).toBe(true);

    releaseReport?.();
    await active;

    expect(collector.isActive()).toBe(false);

    const failing = collector.trigger();
    releaseReport?.(new Error("report failed"));

    await expect(failing).rejects.toThrow("report failed");
    expect(collector.isActive()).toBe(false);
  });
});
