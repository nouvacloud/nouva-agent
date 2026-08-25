import type { DockerApiClient, ManagedContainerLogConfigAdoptionResult } from "./docker-api.js";
import type { ServerValidationCheck } from "./protocol.js";

const SAFE_MANAGED_CONTAINER_KINDS = new Set([
  "app",
  "database",
  "observability",
  "traefik",
  "worker",
  "worker_job",
]);

export interface ManagedContainerLogConfigSummary {
  phase2Ready: boolean;
  total: number;
  compliant: number;
  recreationRequired: number;
  inspectionFailed: number;
  affectedKinds: string[];
  states: Array<"compliant" | "inspection_failed" | "recreation_required">;
}

export function summarizeManagedContainerLogConfigAdoption(
  result: ManagedContainerLogConfigAdoptionResult
): ManagedContainerLogConfigSummary {
  const noncompliant = result.containers.filter((container) => container.status !== "compliant");
  return {
    phase2Ready: result.phase2Ready,
    total: result.containers.length,
    compliant: result.containers.filter((container) => container.status === "compliant").length,
    recreationRequired: result.containers.filter(
      (container) => container.status === "recreation_required"
    ).length,
    inspectionFailed: result.containers.filter(
      (container) => container.status === "inspection_failed"
    ).length,
    affectedKinds: [
      ...new Set(
        noncompliant.flatMap((container) =>
          container.kind && SAFE_MANAGED_CONTAINER_KINDS.has(container.kind)
            ? [container.kind]
            : ["unknown"]
        )
      ),
    ].sort(),
    states: [...new Set(result.containers.map((container) => container.status))].sort(),
  };
}

export async function collectManagedContainerLogConfigValidationCheck(
  docker: Pick<DockerApiClient, "inspectManagedContainerLogConfigAdoption">
): Promise<ServerValidationCheck> {
  try {
    const result = await docker.inspectManagedContainerLogConfigAdoption();
    const summary = summarizeManagedContainerLogConfigAdoption(result);
    return {
      key: "managed-container-logging",
      label: "Managed container logging",
      status: summary.phase2Ready ? "pass" : "fail",
      message: summary.phase2Ready
        ? `${summary.compliant} managed containers use the bounded json-file logging policy.`
        : `${summary.recreationRequired} managed containers require canonical recreation and ${summary.inspectionFailed} could not be inspected. Phase 2 remains disabled.`,
      value: JSON.stringify(summary),
    };
  } catch {
    return {
      key: "managed-container-logging",
      label: "Managed container logging",
      status: "fail",
      message:
        "Managed container logging conformity could not be inspected. Phase 2 remains disabled.",
      value: JSON.stringify({ phase2Ready: false, inspectionFailed: true }),
    };
  }
}
