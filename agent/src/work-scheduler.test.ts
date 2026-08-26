// @ts-expect-error Bun provides the test module at runtime in this workspace.
import { describe, expect, mock, test } from "bun:test";
import { MAX_PARALLEL_AGENT_WORK_ITEMS } from "./protocol.js";
import { createBoundedWorkScheduler } from "./work-scheduler.js";

interface TestWork {
  id: string;
  kind: "backup" | "deploy" | "route";
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("Condition was not reached");
}

describe("createBoundedWorkScheduler", () => {
  test("should keep polling spare capacity while a long backup is running", async () => {
    const backupFinished = createDeferred<void>();
    const requestedLimits: number[] = [];
    const requestedActiveIds: string[][] = [];
    const completedKinds: TestWork["kind"][] = [];
    const processedConfigs: string[] = [];
    let leaseCall = 0;
    const scheduler = createBoundedWorkScheduler<string, TestWork>({
      maxConcurrency: MAX_PARALLEL_AGENT_WORK_ITEMS,
      leaseWork: async (limit, activeWorkItemIds) => {
        requestedLimits.push(limit);
        requestedActiveIds.push([...activeWorkItemIds]);
        leaseCall += 1;
        if (leaseCall === 1) {
          return { config: "config-1", workItems: [{ id: "backup_1", kind: "backup" }] };
        }
        return {
          config: "config-2",
          workItems: [
            { id: "deploy_1", kind: "deploy" },
            { id: "route_1", kind: "route" },
          ],
        };
      },
      processWork: async (_config, workItem) => {
        processedConfigs.push(_config);
        if (workItem.kind === "backup") {
          await backupFinished.promise;
        }
        completedKinds.push(workItem.kind);
      },
      onConfig: mock(() => undefined),
      onWorkError: mock(() => undefined),
    });

    await scheduler.trigger();
    await waitFor(() => scheduler.activeCount() === 1);
    await scheduler.trigger();
    await waitFor(() => completedKinds.includes("deploy") && completedKinds.includes("route"));
    await waitFor(() => scheduler.activeCount() === 1);

    expect(requestedLimits).toEqual([4, 3]);
    expect(requestedActiveIds).toEqual([[], ["backup_1"]]);
    expect(completedKinds).not.toContain("backup");
    expect(scheduler.activeCount()).toBe(1);

    backupFinished.resolve();
    await waitFor(() => scheduler.activeCount() === 0);
    expect(completedKinds).toEqual(["deploy", "route", "backup"]);
    expect(processedConfigs).toEqual(["config-1", "config-2", "config-2"]);
  });

  test("should serialize lease polls and enforce the response bound", async () => {
    const leaseResult = createDeferred<{ config: string; workItems: TestWork[] }>();
    const processWork = mock(async () => undefined);
    const scheduler = createBoundedWorkScheduler<string, TestWork>({
      maxConcurrency: 2,
      leaseWork: mock(() => leaseResult.promise),
      processWork,
      onConfig: mock(() => undefined),
      onWorkError: mock(() => undefined),
    });

    const firstPoll = scheduler.trigger();
    await scheduler.trigger();
    leaseResult.resolve({
      config: "config",
      workItems: [
        { id: "work_1", kind: "deploy" },
        { id: "work_2", kind: "route" },
        { id: "work_3", kind: "backup" },
      ],
    });

    await expect(firstPoll).rejects.toThrow("Lease response exceeded the requested capacity of 2");
    expect(processWork).not.toHaveBeenCalled();
    expect(scheduler.isActive()).toBe(false);
  });

  test("should report item failures and release the capacity for a later poll", async () => {
    const errors: Array<{ error: unknown; workId: string }> = [];
    let leaseCall = 0;
    const scheduler = createBoundedWorkScheduler<string, TestWork>({
      maxConcurrency: 1,
      leaseWork: async () => {
        leaseCall += 1;
        return {
          config: "config",
          workItems: [{ id: `work_${leaseCall}`, kind: "deploy" }],
        };
      },
      processWork: async (_config, workItem) => {
        if (workItem.id === "work_1") {
          throw new Error("boom");
        }
      },
      onConfig: mock(() => undefined),
      onWorkError: (error, workItem) => errors.push({ error, workId: workItem.id }),
    });

    await scheduler.trigger();
    await waitFor(() => scheduler.activeCount() === 0);
    await scheduler.trigger();
    await waitFor(() => scheduler.activeCount() === 0);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.workId).toBe("work_1");
    expect((errors[0]?.error as Error).message).toBe("boom");
    expect(leaseCall).toBe(2);
  });

  test("should skip an already-active lease without stranding unrelated returned work", async () => {
    const backupFinished = createDeferred<void>();
    const processed: string[] = [];
    const errors: string[] = [];
    let leaseCall = 0;
    const scheduler = createBoundedWorkScheduler<string, TestWork>({
      maxConcurrency: 3,
      leaseWork: async () => {
        leaseCall += 1;
        return leaseCall === 1
          ? { config: "config", workItems: [{ id: "backup_1", kind: "backup" }] }
          : {
              config: "config",
              workItems: [
                { id: "backup_1", kind: "backup" },
                { id: "deploy_1", kind: "deploy" },
              ],
            };
      },
      processWork: async (_config, workItem) => {
        if (workItem.id === "backup_1") {
          await backupFinished.promise;
        }
        processed.push(workItem.id);
      },
      onConfig: mock(() => undefined),
      onWorkError: (error) => errors.push((error as Error).message),
    });

    await scheduler.trigger();
    await waitFor(() => scheduler.activeCount() === 1);
    await scheduler.trigger();
    await waitFor(() => processed.includes("deploy_1"));
    await waitFor(() => scheduler.activeCount() === 1);

    expect(processed).not.toContain("backup_1");
    expect(errors).toEqual(["Lease response contained already-active work item backup_1"]);
    expect(scheduler.activeCount()).toBe(1);

    backupFinished.resolve();
    await waitFor(() => scheduler.activeCount() === 0);
  });
});
