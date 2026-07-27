export interface VolumeMetricsCollector {
  trigger: () => Promise<boolean>;
  isActive: () => boolean;
}

export function createVolumeMetricsCollector(report: () => Promise<void>): VolumeMetricsCollector {
  let activeReport: Promise<void> | null = null;

  return {
    async trigger() {
      if (activeReport) {
        return false;
      }

      activeReport = report();
      try {
        await activeReport;
        return true;
      } finally {
        activeReport = null;
      }
    },
    isActive() {
      return activeReport !== null;
    },
  };
}
