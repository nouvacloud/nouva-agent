import type { DockerApiClient, DockerContainerInspection } from "./docker-api.js";

/** Enumerate stopped as well as running containers; names and stale metadata are not ownership. */
export async function removeManagedServiceContainers(
  docker: Pick<DockerApiClient, "listContainersByLabels" | "removeContainer">,
  serviceId: string,
  deploymentId?: string
): Promise<DockerContainerInspection[]> {
  if (!serviceId || deploymentId === "") throw new Error("Container cleanup requires a scope");
  const labels: Record<string, string> = {
    "nouva.managed": "true",
    "nouva.service.id": serviceId,
    ...(deploymentId ? { "nouva.deployment.id": deploymentId } : {}),
  };
  const list = async () =>
    (await docker.listContainersByLabels(labels)).filter((container) =>
      Object.entries(labels).every(([key, value]) => container.Config?.Labels?.[key] === value)
    );
  const containers = await list();
  for (const container of containers) {
    if (!container.Id) throw new Error("Managed container has no ID");
    await docker.removeContainer(container.Id, true);
  }
  if ((await list()).length > 0)
    throw new Error("Managed service containers still exist after cleanup");
  return containers;
}
