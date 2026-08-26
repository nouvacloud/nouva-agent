export interface WorkLeaseBatch<TConfig, TWork> {
  config: TConfig;
  workItems: TWork[];
}

export interface BoundedWorkScheduler {
  activeCount(): number;
  isActive(): boolean;
  trigger(): Promise<void>;
}

export function createBoundedWorkScheduler<TConfig, TWork extends { id: string }>(input: {
  maxConcurrency: number;
  leaseWork: (
    limit: number,
    activeWorkItemIds: readonly string[]
  ) => Promise<WorkLeaseBatch<TConfig, TWork>>;
  processWork: (config: TConfig, workItem: TWork) => Promise<void>;
  onConfig: (config: TConfig) => void;
  onWorkError: (error: unknown, workItem: TWork) => void;
}): BoundedWorkScheduler {
  if (!Number.isSafeInteger(input.maxConcurrency) || input.maxConcurrency < 1) {
    throw new Error("maxConcurrency must be a positive safe integer");
  }

  const activeWork = new Map<string, Promise<void>>();
  let pollActive = false;

  return {
    activeCount: () => activeWork.size,
    isActive: () => pollActive || activeWork.size > 0,
    async trigger(): Promise<void> {
      if (pollActive) {
        return;
      }

      const availableCapacity = input.maxConcurrency - activeWork.size;
      if (availableCapacity <= 0) {
        return;
      }

      pollActive = true;
      try {
        const leased = await input.leaseWork(availableCapacity, [...activeWork.keys()].sort());
        input.onConfig(leased.config);

        if (leased.workItems.length > availableCapacity) {
          throw new Error(`Lease response exceeded the requested capacity of ${availableCapacity}`);
        }

        const workIds = new Set<string>();
        for (const workItem of leased.workItems) {
          if (workIds.has(workItem.id) || activeWork.has(workItem.id)) {
            input.onWorkError(
              new Error(`Lease response contained already-active work item ${workItem.id}`),
              workItem
            );
            continue;
          }
          workIds.add(workItem.id);
        }

        for (const workItem of leased.workItems) {
          if (!workIds.delete(workItem.id)) {
            continue;
          }
          const execution = Promise.resolve()
            .then(() => input.processWork(leased.config, workItem))
            .catch((error) => {
              input.onWorkError(error, workItem);
            })
            .finally(() => {
              activeWork.delete(workItem.id);
            });
          activeWork.set(workItem.id, execution);
        }
      } finally {
        pollActive = false;
      }
    },
  };
}
