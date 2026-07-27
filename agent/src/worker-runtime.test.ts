import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DockerContainerInspection, DockerContainerSpec } from "./docker-api.js";
import type { WorkerDeployOnlyPayload, WorkerJobPayload } from "./protocol.js";
import {
  buildWorkerContainerSpec,
  buildWorkerJobContainerName,
  buildWorkerReplicaContainerName,
  cleanupWorkerJob,
  deployWorkerRuntime,
  inspectWorkerJob,
  removeWorkerServiceRuntime,
  startWorkerJob,
  waitForWorkerReadiness,
} from "./worker-runtime.js";

const resourceLimits = {
  cpuMillicores: 250,
  memoryBytes: 512 * 1024 * 1024,
  pidsLimit: 256,
  policyVersion: 1,
} as const;

const environment = {
  serverId: "srv_1",
  imageStoreMode: "docker-local" as const,
  dataDir: "/tmp/nouva-worker-runtime-tests",
  dataVolume: "nouva-agent-data",
};

const workerPayload: WorkerDeployOnlyPayload = {
  imageUrl: "registry.example/nouva-worker:dep_1",
  commitHash: "abc123",
  commitMessage: "feat: worker",
  serviceName: "queue-consumer",
  projectId: "proj_1",
  environmentId: "env_1",
  serviceId: "svc_1",
  deploymentId: "dep_1",
  envVars: { NODE_ENV: "production" },
  startCommand: null,
  healthCheckCommand: null,
  replicaCount: 1,
  volume: null,
  resourceLimits,
  runtimeMetadata: null,
};

const workerImage = {
  Id: "img_worker_1",
  Config: {
    Entrypoint: ["node"],
    Cmd: ["dist/worker.js"],
  },
};

function getWorkerJobReceiptPath(dataDir: string, scheduleRunId: string): string {
  return path.join(
    dataDir,
    "worker-job-receipts",
    `${Buffer.from(scheduleRunId).toString("base64url")}.json`
  );
}

function createRuntimeDocker() {
  const containers = new Map<string, DockerContainerInspection>();
  let nextContainer = 0;

  const findContainer = (identifier: string) =>
    containers.get(identifier) ??
    [...containers.values()].find((container) => container.Id === identifier) ??
    null;

  const docker = {
    containerLogs: mock(async () => ""),
    createContainer: mock(async (spec: DockerContainerSpec) => {
      const id = `ctr_task_${++nextContainer}`;
      containers.set(spec.name, {
        Id: id,
        Name: spec.name,
        Config: { Image: spec.image, Labels: spec.labels },
        State: { Running: false, Status: "created", ExitCode: 0 },
      });
      return id;
    }),
    createVolume: mock(async () => {}),
    ensureContainer: mock(async (spec: DockerContainerSpec) => {
      const existing = containers.get(spec.name);
      if (existing) {
        existing.State = {
          Running: true,
          Status: "running",
          Health: { Status: "healthy" },
          ExitCode: 0,
        };
        return existing.Id;
      }
      const id = `ctr_worker_${++nextContainer}`;
      containers.set(spec.name, {
        Id: id,
        Name: spec.name,
        Config: { Image: spec.image, Labels: spec.labels },
        State: {
          Running: true,
          Status: "running",
          Health: { Status: "healthy" },
          ExitCode: 0,
        },
      });
      return id;
    }),
    ensureNetwork: mock(async () => {}),
    inspectContainer: mock(async (identifier: string) => findContainer(identifier)),
    inspectImage: mock(async () => workerImage),
    listContainersByLabels: mock(async (labels: Record<string, string>) =>
      [...containers.values()].filter((container) =>
        Object.entries(labels).every(([key, value]) => container.Config?.Labels?.[key] === value)
      )
    ),
    listContainersUsingVolume: mock(async (volumeName: string) =>
      [...containers.values()].filter((container) =>
        container.Mounts?.some((mount) => mount.Name === volumeName || mount.Source === volumeName)
      )
    ),
    pullImage: mock(async () => {}),
    removeContainer: mock(async (identifier: string) => {
      const container = findContainer(identifier);
      if (container) {
        containers.delete(container.Name);
      }
    }),
    removeImage: mock(async () => {}),
    restartContainer: mock(async () => {}),
    startContainer: mock(async (identifier: string) => {
      const container = findContainer(identifier);
      if (!container) throw new Error(`Missing ${identifier}`);
      container.State = { Running: true, Status: "running", ExitCode: 0 };
    }),
    stopContainer: mock(async (identifier: string) => {
      const container = findContainer(identifier);
      if (container) {
        container.State = { Running: false, Status: "exited", ExitCode: 137 };
      }
    }),
    waitContainer: mock(async () => 0),
  };

  return { containers, docker };
}

describe("worker container specs", () => {
  test("uses a deterministic replica name and never configures ingress or ports", () => {
    const result = buildWorkerContainerSpec({
      environment,
      payload: workerPayload,
      image: workerImage,
      replicaIndex: 2,
    });

    expect(buildWorkerReplicaContainerName("svc_1", "dep_1", 2)).toBe("nouva-worker-svc_1-dep_1-2");
    expect(result.containerName).toBe("nouva-worker-svc_1-dep_1-2");
    expect(result.spec.entrypoint).toBeUndefined();
    expect(result.spec.cmd).toBeUndefined();
    expect(result.spec.exposedPorts).toBeUndefined();
    expect(result.spec.hostConfig).not.toHaveProperty("PortBindings");
    expect(result.spec.hostConfig).not.toHaveProperty("NetworkMode");
    expect(result.spec.networkingConfig).toEqual({
      EndpointsConfig: {
        [result.projectNetwork]: {},
      },
    });
    expect(result.spec.labels).toEqual(
      expect.objectContaining({
        "nouva.kind": "worker",
        "nouva.service.type": "worker",
        "nouva.replica.index": "2",
        "nouva.service.id": "svc_1",
      })
    );
    expect(result.imageCommand).toEqual({
      entrypoint: ["node"],
      command: ["dist/worker.js"],
      display: "node dist/worker.js",
    });
  });

  test("uses fixed Docker health check defaults for an explicit worker command", () => {
    const result = buildWorkerContainerSpec({
      environment,
      payload: {
        ...workerPayload,
        startCommand: "node dist/override.js",
        healthCheckCommand: "node scripts/health.js",
      },
      image: workerImage,
      replicaIndex: 0,
    });

    expect(result.spec.entrypoint).toEqual(["/bin/sh", "-lc"]);
    expect(result.spec.cmd).toEqual(["node dist/override.js"]);
    expect(result.spec.healthcheck).toEqual({
      Test: ["CMD-SHELL", "node scripts/health.js"],
      Interval: 10_000_000_000,
      Timeout: 5_000_000_000,
      Retries: 3,
      StartPeriod: 10_000_000_000,
    });
  });

  test("fails before creating a worker with no override or image default command", () => {
    expect(() =>
      buildWorkerContainerSpec({
        environment,
        payload: workerPayload,
        image: { Id: "img_empty", Config: { Entrypoint: [], Cmd: [] } },
        replicaIndex: 0,
      })
    ).toThrow("has no runnable default entrypoint or command");
  });
});

describe("worker readiness", () => {
  test("resets the ten-second running grace period after a restart", async () => {
    let now = 0;
    let inspectionCount = 0;
    const docker = {
      inspectContainer: mock(async () => {
        inspectionCount += 1;
        return {
          Id: "ctr_1",
          Name: "nouva-worker-svc_1-dep_1-0",
          RestartCount: inspectionCount === 1 ? 0 : 1,
          State: { Running: true, Status: "running" },
        };
      }),
    };

    await waitForWorkerReadiness(docker as never, {
      containerName: "nouva-worker-svc_1-dep_1-0",
      hasHealthcheck: false,
      timeoutMs: 100,
      intervalMs: 1,
      runningGraceMs: 10,
      now: () => now,
      wait: async () => {
        now += 10;
      },
    });

    expect(inspectionCount).toBe(3);
  });

  test("fails a candidate as soon as its health check becomes unhealthy", async () => {
    const docker = {
      inspectContainer: mock(async () => ({
        Id: "ctr_1",
        Name: "nouva-worker-svc_1-dep_1-0",
        State: { Running: true, Status: "running", Health: { Status: "unhealthy" } },
      })),
    };

    await expect(
      waitForWorkerReadiness(docker as never, {
        containerName: "nouva-worker-svc_1-dep_1-0",
        hasHealthcheck: true,
      })
    ).rejects.toThrow("became unhealthy");
  });
});

describe("worker convergence and cleanup", () => {
  test("converges 1 to 3 to 1 replicas without any ingress runtime", async () => {
    const { containers, docker } = createRuntimeDocker();
    const payload = { ...workerPayload, healthCheckCommand: "true" };

    await deployWorkerRuntime(docker as never, environment, payload);
    expect(containers.size).toBe(1);

    const scaleUp = await deployWorkerRuntime(docker as never, environment, {
      ...payload,
      replicaCount: 3,
    });
    expect(containers.size).toBe(3);
    expect(scaleUp.runtimeInstances).toHaveLength(3);
    expect(docker.ensureNetwork).toHaveBeenCalled();

    const scaleDown = await deployWorkerRuntime(docker as never, environment, payload);
    expect(containers.size).toBe(1);
    expect(scaleDown.runtimeInstances).toHaveLength(1);
    expect(docker.removeContainer).toHaveBeenCalledWith("ctr_worker_2", true);
    expect(docker.removeContainer).toHaveBeenCalledWith("ctr_worker_3", true);
  });

  test("resets an incomplete volume candidate before retrying the single-writer cutover", async () => {
    const { containers, docker } = createRuntimeDocker();
    const volume = {
      volumeId: "vol_1",
      volumeName: "nouva-vol-1",
      mountPath: "/data",
    };
    await deployWorkerRuntime(docker as never, environment, {
      ...workerPayload,
      deploymentId: "dep_old",
      imageUrl: "registry.example/nouva-worker:dep_old",
      healthCheckCommand: "true",
      volume,
    });

    const candidateName = buildWorkerReplicaContainerName("svc_1", "dep_new", 0);
    containers.set(candidateName, {
      Id: "ctr_incomplete_candidate",
      Name: candidateName,
      Config: {
        Image: "registry.example/nouva-worker:dep_new",
        Labels: {
          "nouva.managed": "true",
          "nouva.kind": "worker",
          "nouva.service.type": "worker",
          "nouva.project.id": "proj_1",
          "nouva.service.id": "svc_1",
          "nouva.deployment.id": "dep_new",
          "nouva.replica.index": "0",
        },
      },
      Mounts: [{ Name: volume.volumeName }],
      State: { Running: true, Status: "running", Health: { Status: "healthy" } },
    });

    const result = await deployWorkerRuntime(docker as never, environment, {
      ...workerPayload,
      deploymentId: "dep_new",
      imageUrl: "registry.example/nouva-worker:dep_new",
      healthCheckCommand: "true",
      volume,
    });

    expect(docker.removeContainer).toHaveBeenCalledWith("ctr_incomplete_candidate", true);
    expect(containers.has("nouva-worker-svc_1-dep_old-0")).toBe(false);
    expect(containers.has(candidateName)).toBe(true);
    expect(result.rollout).toEqual(
      expect.objectContaining({ outcome: "committed", strategy: "single_writer_snapshot_cutover" })
    );
  });

  test("discovers every worker replica by managed labels before issuing plural cleanup proof", async () => {
    const { containers, docker } = createRuntimeDocker();
    await deployWorkerRuntime(docker as never, environment, {
      ...workerPayload,
      replicaCount: 2,
      healthCheckCommand: "true",
    });

    const result = await removeWorkerServiceRuntime(docker as never, {
      serviceId: "svc_1",
      runtimeMetadata: {
        imageStoreMode: "docker-local",
        currentImage: { reference: "registry.example/nouva-worker:dep_1", imageId: "img_worker_1" },
        previousImage: {
          reference: "registry.example/nouva-worker:old",
          imageId: "img_worker_old",
        },
      },
    });

    expect(containers.size).toBe(0);
    expect(result.cleanupProof).toEqual({
      version: 1,
      kind: "delete_worker",
      containers: [
        { identifier: "ctr_worker_1", absent: true },
        { identifier: "ctr_worker_2", absent: true },
      ],
      retainedImages: [
        { reference: "registry.example/nouva-worker:dep_1", absent: true },
        { reference: "registry.example/nouva-worker:old", absent: true },
      ],
    });
  });

  test("scales to zero even when a scheduled-only image is no longer local", async () => {
    const { containers, docker } = createRuntimeDocker();
    await deployWorkerRuntime(docker as never, environment, {
      ...workerPayload,
      healthCheckCommand: "true",
    });
    docker.inspectImage.mockImplementation(async () => null);

    const result = await deployWorkerRuntime(docker as never, environment, {
      ...workerPayload,
      replicaCount: 0,
      runtimeMetadata: {
        imageStoreMode: "docker-local",
        currentImage: {
          reference: workerPayload.imageUrl,
          imageId: "img_worker_1",
          deploymentId: "dep_1",
          commitHash: "abc123",
        },
      },
    });

    expect(containers.size).toBe(0);
    expect(result.runtimeInstances).toEqual([]);
  });
});

describe("scheduled worker job receipts", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
    );
  });

  test("returns the receipt on retry without starting the user command twice", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "nouva-worker-job-"));
    tempDirs.push(dataDir);
    const { docker } = createRuntimeDocker();
    const payload: WorkerJobPayload = {
      projectId: "proj_1",
      environmentId: "env_1",
      serviceId: "svc_1",
      deploymentId: "dep_1",
      scheduleId: "schedule_1",
      scheduleRunId: "run_1",
      occurrenceKey: "2026-07-27T12:00:00.000Z",
      jobName: "hourly-sync",
      imageUrl: workerPayload.imageUrl,
      envVars: { NODE_ENV: "production" },
      command: "node dist/sync.js",
      timeoutSeconds: 1800,
      volume: null,
      resourceLimits,
    };
    const jobEnvironment = { ...environment, dataDir };

    const first = await startWorkerJob(docker as never, jobEnvironment, payload);
    const inspection = await inspectWorkerJob(docker as never, jobEnvironment, {
      scheduleRunId: "run_1",
    });
    const second = await startWorkerJob(docker as never, jobEnvironment, payload);

    expect(first.job).toEqual(
      expect.objectContaining({ status: "running", scheduleRunId: "run_1" })
    );
    expect(inspection.job).toEqual(
      expect.objectContaining({
        status: "running",
        occurrenceKey: "2026-07-27T12:00:00.000Z",
        image: workerPayload.imageUrl,
      })
    );
    expect(second.job).toEqual(
      expect.objectContaining({ status: "running", scheduleRunId: "run_1" })
    );
    expect(docker.createContainer).toHaveBeenCalledTimes(1);
    expect(docker.startContainer).toHaveBeenCalledTimes(1);
  });

  test("recovers a labeled container when the agent lost its local receipt", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "nouva-worker-job-"));
    tempDirs.push(dataDir);
    const { docker } = createRuntimeDocker();
    const payload: WorkerJobPayload = {
      projectId: "proj_1",
      environmentId: "env_1",
      serviceId: "svc_1",
      deploymentId: "dep_1",
      scheduleId: "schedule_1",
      scheduleRunId: "run_lost_receipt",
      occurrenceKey: "2026-07-27T12:01:00.000Z",
      jobName: "hourly-sync",
      imageUrl: workerPayload.imageUrl,
      envVars: { NODE_ENV: "production" },
      command: "node dist/sync.js",
      timeoutSeconds: 1800,
      volume: null,
      resourceLimits,
    };
    const jobEnvironment = { ...environment, dataDir };

    await startWorkerJob(docker as never, jobEnvironment, payload);
    await rm(getWorkerJobReceiptPath(dataDir, payload.scheduleRunId), { force: true });
    const recovered = await startWorkerJob(docker as never, jobEnvironment, payload);

    expect(recovered.job).toEqual(
      expect.objectContaining({ status: "running", scheduleRunId: payload.scheduleRunId })
    );
    expect(docker.createContainer).toHaveBeenCalledTimes(1);
    expect(docker.startContainer).toHaveBeenCalledTimes(1);
  });

  test("recovers a terminal no-receipt container before proving cleanup", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "nouva-worker-job-"));
    tempDirs.push(dataDir);
    const { containers, docker } = createRuntimeDocker();
    const payload: WorkerJobPayload = {
      projectId: "proj_1",
      environmentId: "env_1",
      serviceId: "svc_1",
      deploymentId: "dep_1",
      scheduleId: "schedule_1",
      scheduleRunId: "run_cleanup_lost_receipt",
      occurrenceKey: "2026-07-27T12:02:00.000Z",
      jobName: "hourly-sync",
      imageUrl: workerPayload.imageUrl,
      envVars: { NODE_ENV: "production" },
      command: "node dist/sync.js",
      timeoutSeconds: 1800,
      volume: null,
      resourceLimits,
    };
    const jobEnvironment = { ...environment, dataDir };

    const started = await startWorkerJob(docker as never, jobEnvironment, payload);
    const containerId = String((started.job as { containerId: string }).containerId);
    const container = containers.get(
      buildWorkerJobContainerName(payload.serviceId, payload.scheduleRunId)
    );
    if (!container) {
      throw new Error("Expected test worker job container");
    }
    container.State = { Running: false, Status: "exited", ExitCode: 0 };
    await rm(getWorkerJobReceiptPath(dataDir, payload.scheduleRunId), { force: true });

    const result = await cleanupWorkerJob(docker as never, jobEnvironment, {
      serviceId: payload.serviceId,
      scheduleRunId: payload.scheduleRunId,
    });

    expect(result.cleanupProof).toEqual({
      version: 1,
      kind: "cleanup_worker_job",
      container: { identifier: containerId, absent: true },
    });
    expect(
      containers.has(buildWorkerJobContainerName(payload.serviceId, payload.scheduleRunId))
    ).toBe(false);
  });

  test("inspects the deterministic container name before proving a missing receipt absent", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "nouva-worker-job-"));
    tempDirs.push(dataDir);
    const { docker } = createRuntimeDocker();
    const jobEnvironment = { ...environment, dataDir };
    const serviceId = "svc_1";
    const scheduleRunId = "run_absent";

    const result = await cleanupWorkerJob(docker as never, jobEnvironment, {
      serviceId,
      scheduleRunId,
    });

    expect(docker.inspectContainer).toHaveBeenCalledWith(
      buildWorkerJobContainerName(serviceId, scheduleRunId)
    );
    expect(result.cleanupProof).toEqual({
      version: 1,
      kind: "cleanup_worker_job",
      container: {
        identifier: buildWorkerJobContainerName(serviceId, scheduleRunId),
        absent: true,
      },
    });
  });
});
