// @ts-expect-error Bun provides the test module at runtime in this workspace.
import { describe, expect, test } from "bun:test";
import { createSerializedTaskRunner } from "./serialized-task.js";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("createSerializedTaskRunner", () => {
  test("should run shared-runtime reconciliation one caller at a time", async () => {
    const firstFinished = createDeferred<void>();
    const events: string[] = [];
    const runner = createSerializedTaskRunner();

    const first = runner.run(async () => {
      events.push("first-started");
      await firstFinished.promise;
      events.push("first-finished");
    });
    const second = runner.run(async () => {
      events.push("second-started");
    });
    await Promise.resolve();

    expect(events).toEqual(["first-started"]);
    firstFinished.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-started", "first-finished", "second-started"]);
  });

  test("should continue the queue after a failed reconciliation", async () => {
    const runner = createSerializedTaskRunner();
    const first = runner.run(async () => {
      throw new Error("reconcile failed");
    });
    const second = runner.run(async () => "healthy");

    await expect(first).rejects.toThrow("reconcile failed");
    await expect(second).resolves.toBe("healthy");
  });
});
