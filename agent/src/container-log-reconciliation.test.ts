import { describe, expect, mock, test } from "bun:test";

import { collectManagedContainerLogConfigValidationCheck } from "./container-log-reconciliation.js";

describe("managed container logging validation", () => {
  test("reports only aggregate-safe drift while keeping phase two fail closed", async () => {
    const inspectManagedContainerLogConfigAdoption = mock(async () => ({
      phase2Ready: false,
      containers: [
        {
          containerId: "container-secret-id",
          containerName: "customer-secret-name",
          kind: "database",
          status: "recreation_required" as const,
          stateful: true,
          preservedVolumeNames: ["customer-secret-volume"],
        },
        {
          containerId: "missing-secret-id",
          containerName: "missing-secret-name",
          kind: "context-v1-secret-kind",
          status: "inspection_failed" as const,
          stateful: false,
          preservedVolumeNames: [],
        },
      ],
    }));

    const check = await collectManagedContainerLogConfigValidationCheck({
      inspectManagedContainerLogConfigAdoption,
    });

    expect(check).toEqual(
      expect.objectContaining({
        key: "managed-container-logging",
        status: "fail",
      })
    );
    expect(JSON.parse(check.value ?? "{}")).toEqual({
      phase2Ready: false,
      total: 2,
      compliant: 0,
      recreationRequired: 1,
      inspectionFailed: 1,
      affectedKinds: ["database", "unknown"],
      states: ["inspection_failed", "recreation_required"],
    });
    expect(`${check.message} ${check.value}`).not.toContain("secret");
  });

  test("fails closed when Docker inventory cannot be read", async () => {
    const check = await collectManagedContainerLogConfigValidationCheck({
      inspectManagedContainerLogConfigAdoption: mock(async () => {
        throw new Error("docker socket token-should-not-escape");
      }),
    });

    expect(check.status).toBe("fail");
    expect(check.message).not.toContain("token-should-not-escape");
    expect(JSON.parse(check.value ?? "{}")).toEqual({
      phase2Ready: false,
      inspectionFailed: true,
    });
  });
});
