import { expect, mock, test } from "bun:test";
import type { DockerContainerInspection } from "./docker-api.js";
import { removeManagedServiceContainers } from "./service-container-cleanup.js";

test("deployment removal sweeps its stopped and running containers without touching other deployments", async () => {
  const containers = new Map(
    ["target", "old", "foreign", "unmanaged"].map((id) => [
      id,
      {
        Id: id,
        Name: id,
        State: { Running: id !== "old" },
        Config: {
          Labels: {
            "nouva.managed": id === "unmanaged" ? "false" : "true",
            "nouva.service.id": id === "foreign" ? "other" : "svc",
            "nouva.deployment.id": id === "old" ? "old" : "dep",
          },
        },
      },
    ])
  );
  const docker = {
    listContainersByLabels: mock(
      async () => [...containers.values()] as DockerContainerInspection[]
    ),
    removeContainer: mock(async (id: string) => {
      containers.delete(id);
    }),
  };
  await removeManagedServiceContainers(docker, "svc", "dep");
  expect([...containers.keys()]).toEqual(["old", "foreign", "unmanaged"]);
  expect(docker.listContainersByLabels).toHaveBeenCalledWith({
    "nouva.managed": "true",
    "nouva.service.id": "svc",
    "nouva.deployment.id": "dep",
  });
});
