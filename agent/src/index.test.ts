import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import agentPackageJson from "../package.json" with { type: "json" };
import type { DeployAppImageInput } from "./app-build-runtime.js";
import { buildAndDeployAppWithDependencies } from "./app-build-runtime.js";
import { DockerApiError } from "./docker-api.js";
import {
  ApiRequestError,
  buildAppContainerSpec,
  buildDatabaseContainerSpec,
  buildUpdateAgentRuntimeEnv,
  deployAppImageWithDependencies,
  handleApplyDatabaseVolume,
  handleCreateVolumeBackup,
  handleDatabaseProvision,
  handleDeleteService,
  handleDeleteVolume,
  handleRestorePostgresPitr,
  handleRestoreVolumeBackup,
  handleWipeVolume,
  normalizeRuntimeLogEntries,
  prepareAppBuildkitRuntime,
  resolveAgentTaskImage,
  resolveAgentWorkLeaseRenewalIntervalMs,
  resolveReportedAgentVersion,
  resolveServiceContainerIdentifier,
  shouldStopRetryingAgentWorkMutation,
  startAgentWorkLeaseRenewal,
} from "./index.js";
import type {
  AgentRuntimeConfig,
  AppDeployPayload,
  AppRolloutConfig,
  CreateVolumeBackupPayload,
  DatabaseProvisionPayload,
  RestoreVolumeBackupPayload,
} from "./protocol.js";

const runtimeConfig: AgentRuntimeConfig = {
  heartbeatIntervalSeconds: 30,
  pollIntervalSeconds: 10,
  leaseTtlSeconds: 120,
  metricsIntervalSeconds: 30,
  postgresObservabilityIntervalSeconds: 30,
  ingressMode: "local_traefik",
  buildkitMode: "docker-container",
  imageStoreMode: "docker-local",
  capabilities: {
    dockerApi: true,
    buildkit: true,
    localRegistry: true,
    localTraefik: true,
    hostMetrics: true,
    containerMetrics: true,
    runtimeLogs: true,
    postgresObservability: true,
    cleanupProofV1: true,
  },
  localRegistryHost: "127.0.0.1",
  localRegistryPort: 5000,
  localTraefikNetwork: "nouva-local",
  observability: {
    enabled: false,
    organizationId: null,
    alloyImage: "grafana/alloy:latest",
    scrapeIntervalSeconds: 30,
    collectorScope: "services_and_traefik",
    noneLabelValue: "__none__",
  },
};

const resourceLimits = {
  cpuMillicores: 1500,
  memoryBytes: 2 * 1024 * 1024 * 1024,
} as const;

const appPayload: AppDeployPayload = {
  repoUrl: "https://example.com/repo.git",
  commitHash: "abc123",
  commitMessage: "feat: build",
  branch: "main",
  subdomain: "app",
  serviceName: "app",
  projectId: "proj_1",
  serviceId: "svc_1",
  deploymentId: "dep_1",
  environmentId: "env_1",
  envVars: {},
  appBuildType: "dockerfile",
  appBuildConfig: {
    buildRoot: "apps/web",
    dockerfilePath: "Dockerfile",
    dockerContextPath: ".",
    dockerBuildStage: "runner",
  },
  volume: {
    volumeId: "vol_1",
    volumeName: "nouva-vol-vol_1",
    mountPath: "/data",
  },
  resourceLimits,
  runtimeMetadata: null,
};

const appRuntimePayload: DeployAppImageInput = {
  projectId: "proj_1",
  serviceId: "svc_1",
  deploymentId: "dep_1",
  environmentId: "env_1",
  commitHash: "abc123",
  serviceName: "app",
  subdomain: "app",
  envVars: {
    PORT: "8080",
  },
  imageUrl: "127.0.0.1:5000/nouva-app:dep_1",
  volume: {
    volumeId: "vol_1",
    volumeName: "nouva-vol-vol_1",
    mountPath: "/data",
  },
  resourceLimits,
  runtimeMetadata: null,
  detectedLanguage: null,
  detectedFramework: null,
  languageVersion: null,
  internalPort: 8080,
  buildDuration: 100,
};

const databasePayload: DatabaseProvisionPayload = {
  projectId: "proj_1",
  serviceId: "svc_1",
  serviceName: "main-db",
  variant: "postgres",
  environmentId: "env_1",
  volumeId: "vol_1",
  volumeName: "nouva-vol-vol_1",
  mountPath: "/var/lib/postgresql",
  imageUrl: "postgres:17",
  envVars: {
    POSTGRES_USER: "nouva_user",
    POSTGRES_PASSWORD: "super-secret",
  },
  containerArgs: [],
  dataPath: "/var/lib/postgresql/pgdata",
  internalPort: 5432,
  storageSizeGb: 20,
  externalHost: null,
  externalPort: null,
  publicAccessEnabled: false,
  resourceLimits,
  runtimeMetadata: null,
};

const pgBackrestBackupPayload: CreateVolumeBackupPayload = {
  projectId: "proj_1",
  serviceId: "svc_1",
  serviceName: "main-db",
  variant: "postgres",
  version: "17",
  volumeId: "vol_1",
  volumeName: "nouva-vol-vol_1",
  mountPath: "/var/lib/postgresql",
  backupId: "backup_1",
  kind: "MANUAL",
  engine: "pgbackrest",
  pgbackrestType: "full",
  destination: {} as never,
  imageUrl: "postgres:17",
  envVars: {
    POSTGRES_USER: "nouva_user",
    POSTGRES_PASSWORD: "super-secret",
    PGBACKREST_STANZA: "vol-vol_1",
  },
  containerArgs: [],
  dataPath: "/var/lib/postgresql/pgdata",
};

const snapshotBackupPayload: CreateVolumeBackupPayload = {
  projectId: "proj_1",
  serviceId: "svc_redis_1",
  serviceName: "redis-cache",
  variant: "redis",
  version: "7.4",
  volumeId: "vol_redis_1",
  volumeName: "nouva-vol-vol_redis_1",
  mountPath: "/data",
  backupId: "backup_redis_1",
  kind: "MANUAL",
  engine: "snapshot",
  destination: {
    id: "dest_1",
    type: "s3",
    bucket: "nouva-backups",
    endpoint: "https://s3.example.com",
    region: "us-east-1",
    pathStyle: false,
    verifyTls: true,
    accessKeyId: "key-id",
    secretAccessKey: "secret-key",
    pgbackrestRepoType: "s3",
    pgbackrestCipherType: null,
    pgbackrestRetentionFullType: null,
    pgbackrestRetentionFull: null,
    pgbackrestRetentionDiff: null,
    pgbackrestRetentionArchiveType: null,
    pgbackrestRetentionArchive: null,
    pgbackrestRetentionHistory: null,
    pgbackrestArchiveAsync: null,
    pgbackrestSpoolPath: null,
    pgbackrestCipherPass: null,
  },
};

const pgBackrestRestorePayload: RestoreVolumeBackupPayload = {
  projectId: "proj_1",
  serviceId: "svc_1",
  serviceName: "main-db",
  variant: "postgres",
  version: "17",
  sourceVolumeId: "vol_1",
  sourceVolumeName: "nouva-vol-vol_1",
  sourceMountPath: "/var/lib/postgresql",
  targetVolumeId: "vol_restored_1",
  targetVolumeName: "nouva-vol-vol_restored_1",
  targetMountPath: "/var/lib/postgresql",
  backupId: "backup_1",
  engine: "pgbackrest",
  backupCompletedAt: "2026-03-25T00:00:00Z",
  pgbackrestSet: "20260325-000000F",
  destination: {} as never,
  imageUrl: "postgres:17",
  envVars: {
    POSTGRES_USER: "nouva_user",
    POSTGRES_PASSWORD: "super-secret",
    PGBACKREST_STANZA: "vol-vol_1",
  },
  containerArgs: [],
  dataPath: "/var/lib/postgresql/pgdata",
};

const originalAgentImage = process.env.NOUVA_AGENT_IMAGE;
const originalAgentTargetImage = process.env.NOUVA_AGENT_TARGET_IMAGE;
const originalAgentContainerName = process.env.NOUVA_AGENT_CONTAINER_NAME;
const originalHostname = process.env.HOSTNAME;

function createDockerMock() {
  return {
    ensureNetwork: mock(async () => {}),
    createVolume: mock(async () => {}),
    ensureContainer: mock(async () => "ctr_1"),
    connectNetwork: mock(async () => {}),
    inspectContainer: mock(async () => null),
    inspectImage: mock(async () => ({ Id: "img_candidate" })),
    inspectVolume: mock(async () => null),
    removeContainer: mock(async () => {}),
    removeImage: mock(async () => {}),
    removeVolume: mock(async () => {}),
    stopContainer: mock(async () => {}),
    pullImage: mock(async () => {}),
    loadImage: mock(async () => {}),
    createContainer: mock(async () => "task_1"),
    startContainer: mock(async () => {}),
    waitContainer: mock(async () => 0),
    containerLogs: mock(async () => ""),
  };
}

function createRolloutConfig(overrides?: Partial<AppRolloutConfig>): AppRolloutConfig {
  return {
    strategy: "candidate_ready_cutover",
    readiness: {
      timeoutMs: 25,
      intervalMs: 1,
      tcpConnectTimeoutMs: 1,
      ...overrides?.readiness,
    },
    cutover: {
      verificationTimeoutMs: 25,
      verificationIntervalMs: 1,
      ...overrides?.cutover,
    },
    blockSharedVolumes: overrides?.blockSharedVolumes ?? true,
  };
}

describe("agent version reporting", () => {
  test("reports the package version with a v prefix", () => {
    expect(resolveReportedAgentVersion(agentPackageJson.version)).toBe(
      `v${agentPackageJson.version}`
    );
  });

  test("does not inherit NOUVA_AGENT_VERSION during self-update", () => {
    const result = buildUpdateAgentRuntimeEnv(
      {
        NOUVA_API_URL: "https://api.nouvacloud.com",
        NOUVA_SERVER_ID: "srv_1",
        NOUVA_AGENT_DATA_VOLUME: "nouva-agent-data",
        NOUVA_AGENT_IMAGE: "ghcr.io/nouvacloud/nouva-agent:v0.1.0",
        NOUVA_AGENT_TARGET_IMAGE: "ghcr.io/nouvacloud/nouva-agent:v0.1.0",
        NOUVA_AGENT_VERSION: "v0.1.0",
        PATH: "/usr/bin",
      },
      "ghcr.io/nouvacloud/nouva-agent:latest"
    );

    expect(result).toEqual({
      updaterEnv: [
        "NOUVA_AGENT_DATA_VOLUME=nouva-agent-data",
        "NOUVA_API_URL=https://api.nouvacloud.com",
        "NOUVA_SERVER_ID=srv_1",
        "NOUVA_AGENT_IMAGE=ghcr.io/nouvacloud/nouva-agent:latest",
        "NOUVA_AGENT_TARGET_IMAGE=ghcr.io/nouvacloud/nouva-agent:latest",
      ],
      envInheritFlags:
        "-e NOUVA_AGENT_DATA_VOLUME -e NOUVA_API_URL -e NOUVA_SERVER_ID -e NOUVA_AGENT_IMAGE -e NOUVA_AGENT_TARGET_IMAGE",
    });
  });
});

describe("resolveAgentTaskImage", () => {
  beforeEach(() => {
    delete process.env.NOUVA_AGENT_IMAGE;
    delete process.env.NOUVA_AGENT_TARGET_IMAGE;
    delete process.env.NOUVA_AGENT_CONTAINER_NAME;
    delete process.env.HOSTNAME;
  });

  afterEach(() => {
    if (originalAgentImage === undefined) delete process.env.NOUVA_AGENT_IMAGE;
    else process.env.NOUVA_AGENT_IMAGE = originalAgentImage;
    if (originalAgentTargetImage === undefined) delete process.env.NOUVA_AGENT_TARGET_IMAGE;
    else process.env.NOUVA_AGENT_TARGET_IMAGE = originalAgentTargetImage;
    if (originalAgentContainerName === undefined) delete process.env.NOUVA_AGENT_CONTAINER_NAME;
    else process.env.NOUVA_AGENT_CONTAINER_NAME = originalAgentContainerName;
    if (originalHostname === undefined) delete process.env.HOSTNAME;
    else process.env.HOSTNAME = originalHostname;
  });

  test("returns the configured agent image when NOUVA_AGENT_IMAGE is set", async () => {
    const docker = createDockerMock();
    process.env.NOUVA_AGENT_IMAGE = "example.com/custom/nouva-agent:1.0.0";

    await expect(resolveAgentTaskImage(docker as never)).resolves.toBe(
      "example.com/custom/nouva-agent:1.0.0"
    );
    expect(docker.inspectContainer).not.toHaveBeenCalled();
  });

  test("falls back to inspecting the running agent container image when env is missing", async () => {
    const docker = createDockerMock();
    process.env.HOSTNAME = "ctr_agent_1";
    docker.inspectContainer.mockImplementation(async (nameOrId: string) =>
      nameOrId === "ctr_agent_1"
        ? {
            Id: "ctr_agent_1",
            Config: {
              Image: "ghcr.io/nouvacloud/nouva-agent:v0.4.10",
            },
          }
        : null
    );

    await expect(resolveAgentTaskImage(docker as never)).resolves.toBe(
      "ghcr.io/nouvacloud/nouva-agent:v0.4.10"
    );
  });
});

describe("agent work mutation errors", () => {
  test("stops retrying when the control plane reports the work is gone or superseded", () => {
    expect(
      shouldStopRetryingAgentWorkMutation(
        new ApiRequestError({
          method: "POST",
          pathName: "/api/agent/work/work_1/complete",
          status: 404,
          message: "Work item not found",
        })
      )
    ).toBe(true);
    expect(
      shouldStopRetryingAgentWorkMutation(
        new ApiRequestError({
          method: "POST",
          pathName: "/api/agent/work/work_1/complete",
          status: 422,
          message: "Cleanup verification failed",
        })
      )
    ).toBe(true);
    expect(
      shouldStopRetryingAgentWorkMutation(
        new ApiRequestError({
          method: "POST",
          pathName: "/api/agent/work/work_1/fail",
          status: 409,
          message: "Work item lease is no longer active",
        })
      )
    ).toBe(true);
  });

  test("keeps retrying on non-terminal agent work mutation failures", () => {
    expect(
      shouldStopRetryingAgentWorkMutation(
        new ApiRequestError({
          method: "POST",
          pathName: "/api/agent/work/work_1/complete",
          status: 500,
          message: "boom",
        })
      )
    ).toBe(false);
    expect(shouldStopRetryingAgentWorkMutation(new Error("network exploded"))).toBe(false);
  });
});

describe("agent work lease renewal", () => {
  test("renews at one third of the configured lease TTL with a one-second floor", () => {
    expect(resolveAgentWorkLeaseRenewalIntervalMs(120)).toBe(40_000);
    expect(resolveAgentWorkLeaseRenewalIntervalMs(1)).toBe(1_000);
    expect(resolveAgentWorkLeaseRenewalIntervalMs(0)).toBe(40_000);
    expect(resolveAgentWorkLeaseRenewalIntervalMs(Number.NaN)).toBe(40_000);
  });

  test("does not schedule another renewal while the current request is in flight", async () => {
    let resolveRenewal: (() => void) | undefined;
    const renewLease = mock(
      () =>
        new Promise<{ ok: true; leaseExpiresAt: string }>((resolve) => {
          resolveRenewal = () => resolve({ ok: true, leaseExpiresAt: "2026-03-26T12:02:00.000Z" });
        })
    );
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    const controller = startAgentWorkLeaseRenewal({
      leaseTtlSeconds: 120,
      renewLease,
      schedule: (callback, delayMs) => {
        scheduled.push({ callback, delayMs });
        return callback;
      },
      clearScheduled: () => undefined,
    });

    expect(renewLease).toHaveBeenCalledTimes(1);
    expect(scheduled).toEqual([]);

    resolveRenewal?.();
    await controller.ready;

    expect(scheduled).toEqual([{ callback: expect.any(Function), delayMs: 40_000 }]);
    await controller.stop();
  });

  test("retries transient renewal failures sooner and returns to the normal cadence", async () => {
    const renewLease = mock()
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce({ ok: true, leaseExpiresAt: "2026-03-26T12:02:00.000Z" });
    const onTransientError = mock();
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    const controller = startAgentWorkLeaseRenewal({
      leaseTtlSeconds: 120,
      renewLease,
      onTransientError,
      schedule: (callback, delayMs) => {
        scheduled.push({ callback, delayMs });
        return callback;
      },
      clearScheduled: () => undefined,
    });

    expect(await controller.ready).toBe(true);
    expect(onTransientError).toHaveBeenCalledTimes(1);
    expect(scheduled[0]?.delayMs).toBe(5_000);

    scheduled.shift()?.callback();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(renewLease).toHaveBeenCalledTimes(2);
    expect(scheduled[0]?.delayMs).toBe(40_000);
    await controller.stop();
  });

  test("stops permanently when the control plane rejects lease ownership", async () => {
    const onLeaseLost = mock();
    const schedule = mock();
    const controller = startAgentWorkLeaseRenewal({
      leaseTtlSeconds: 120,
      renewLease: async () => {
        throw new ApiRequestError({
          method: "POST",
          pathName: "/api/agent/work/work_1/renew",
          status: 409,
          message: "Work item lease is no longer active",
        });
      },
      onLeaseLost,
      schedule,
    });

    expect(await controller.ready).toBe(false);
    expect(controller.leaseLost()).toBe(true);
    expect(onLeaseLost).toHaveBeenCalledTimes(1);
    expect(schedule).not.toHaveBeenCalled();
    await controller.stop();
  });

  test("clears scheduled renewals during terminal work reporting", async () => {
    const timer = Symbol("lease-renewal-timer");
    const clearScheduled = mock();
    const controller = startAgentWorkLeaseRenewal({
      leaseTtlSeconds: 120,
      renewLease: async () => ({
        ok: true,
        leaseExpiresAt: "2026-03-26T12:02:00.000Z",
      }),
      schedule: () => timer,
      clearScheduled,
    });

    expect(await controller.ready).toBe(true);
    await controller.stop();

    expect(clearScheduled).toHaveBeenCalledWith(timer);
  });
});

describe("buildAndDeployAppWithDependencies", () => {
  test("forwards resource limits into the deploy step", async () => {
    const calls: string[] = [];
    const ensureBaseRuntime = mock(async () => {
      calls.push("ensure");
    });
    const buildApp = mock(async () => {
      calls.push("build");
      return {
        imageUrl: "127.0.0.1:5000/nouva-app:dep_1",
        imageId: "img_candidate",
        imageSha: "sha256:test",
        buildDuration: 100,
        detectedLanguage: null,
        detectedFramework: null,
        languageVersion: null,
        internalPort: 8080,
      };
    });
    const deployAppImage = mock(async () => {
      calls.push("deploy");
      return {
        runtimeMetadata: null,
      };
    });

    await buildAndDeployAppWithDependencies(
      {
        ensureBaseRuntime,
        buildApp,
        deployAppImage,
      },
      {} as never,
      runtimeConfig,
      appPayload,
      "tcp://127.0.0.1:1234"
    );

    expect(calls).toEqual(["ensure", "build", "deploy"]);
    expect(buildApp).toHaveBeenCalledWith(
      expect.objectContaining({
        appBuildType: "dockerfile",
        appBuildConfig: appPayload.appBuildConfig,
        imageStoreMode: "docker-local",
        resourceLimits: appPayload.resourceLimits,
      })
    );
    expect(deployAppImage.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        volume: appPayload.volume,
        resourceLimits: appPayload.resourceLimits,
      })
    );
  });
});

describe("prepareAppBuildkitRuntime", () => {
  test("creates an isolated resource-limited BuildKit worker for bounded app builds", async () => {
    const docker = {
      ensureContainer: mock(async () => "buildkit_1"),
      removeContainer: mock(async () => {}),
    };
    const waitUntilReady = mock(async () => {});

    const runtime = await prepareAppBuildkitRuntime(
      docker as never,
      {
        deploymentId: "dep_1",
        resourceLimits,
      },
      {
        allocatePort: async () => 4567,
        waitUntilReady,
      }
    );

    expect(runtime.address).toBe("tcp://127.0.0.1:4567");
    expect(docker.ensureContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "nouva-buildkitd-dep_1",
        cmd: ["--addr", "tcp://0.0.0.0:4567"],
        hostConfig: expect.objectContaining({
          Privileged: true,
          NetworkMode: "host",
          RestartPolicy: {
            Name: "no",
          },
          NanoCpus: 1_500_000_000,
          Memory: 2 * 1024 * 1024 * 1024,
        }),
      }),
      true
    );
    expect(waitUntilReady).toHaveBeenCalledWith("tcp://127.0.0.1:4567");

    await runtime.cleanup();

    expect(docker.removeContainer).toHaveBeenCalledWith("nouva-buildkitd-dep_1", true);
  });

  test("reuses the shared BuildKit daemon for unlimited app builds", async () => {
    const docker = {
      ensureContainer: mock(async () => "buildkit_1"),
      removeContainer: mock(async () => {}),
    };

    const runtime = await prepareAppBuildkitRuntime(
      docker as never,
      {
        deploymentId: "dep_1",
        resourceLimits: null,
      },
      {
        sharedAddress: "tcp://127.0.0.1:1234",
      }
    );

    expect(runtime.address).toBe("tcp://127.0.0.1:1234");
    expect(docker.ensureContainer).not.toHaveBeenCalled();

    await runtime.cleanup();

    expect(docker.removeContainer).not.toHaveBeenCalled();
  });
});

describe("buildAppContainerSpec", () => {
  test("includes Docker CPU and memory limits when resource limits are provided", () => {
    const spec = buildAppContainerSpec(runtimeConfig, appRuntimePayload);

    expect(spec.spec.hostConfig).toEqual(
      expect.objectContaining({
        NanoCpus: 1_500_000_000,
        Memory: 2 * 1024 * 1024 * 1024,
      })
    );
  });

  test("omits Docker CPU and memory limits when resource limits are null", () => {
    const spec = buildAppContainerSpec(runtimeConfig, {
      ...appRuntimePayload,
      resourceLimits: null,
    });

    expect(spec.spec.hostConfig).not.toHaveProperty("NanoCpus");
    expect(spec.spec.hostConfig).not.toHaveProperty("Memory");
  });

  test("mounts managed app volumes when they are provided", () => {
    const spec = buildAppContainerSpec(runtimeConfig, appRuntimePayload);

    expect(spec.spec.hostConfig).toEqual(
      expect.objectContaining({
        Mounts: [
          {
            Type: "volume",
            Source: "nouva-vol-vol_1",
            Target: "/data",
          },
        ],
      })
    );
  });

  test("stamps environment labels for app containers", () => {
    const spec = buildAppContainerSpec(runtimeConfig, appRuntimePayload);

    expect(spec.spec.labels).toEqual(
      expect.objectContaining({
        "nouva.environment.id": "env_1",
        "nouva.project.id": "proj_1",
        "nouva.service.id": "svc_1",
        "nouva.deployment.id": "dep_1",
        "nouva.kind": "app",
      })
    );
  });
});

describe("deployAppImageWithDependencies", () => {
  test("keeps the live container in place until the candidate is ready and cut over", async () => {
    const docker = createDockerMock();
    docker.ensureContainer.mockImplementation(async () => "ctr_candidate");
    docker.inspectContainer.mockImplementation(async (name: string) => {
      if (name === "nouva-app-svc_1-dep_1") {
        return {
          Id: "ctr_candidate",
          Name: name,
          State: {
            Running: true,
          },
          NetworkSettings: {
            Networks: {
              "nouva-local": {
                IPAddress: "172.19.0.10",
              },
            },
          },
        };
      }

      return null;
    });

    const writeLocalTraefikRoute = mock(async () => {});
    const deleteLocalTraefikRoute = mock(async () => {});
    const checkTcpConnect = mock(async () => true);
    const fetchImpl: typeof fetch = mock(async () =>
      Response.json([
        {
          name: "svc-svc_1@file",
          loadBalancer: {
            servers: [{ url: "http://nouva-app-svc_1-dep_1:8080" }],
          },
        },
      ])
    ) as typeof fetch;

    const result = await deployAppImageWithDependencies(
      {
        ensureBaseRuntime: async () => undefined,
        checkTcpConnect,
        fetchImpl,
        writeLocalTraefikRoute,
        deleteLocalTraefikRoute,
      },
      docker as never,
      runtimeConfig,
      {
        ...appRuntimePayload,
        volume: null,
        rollout: createRolloutConfig(),
        runtimeMetadata: {
          image: "nouva-app:dep_prev",
          imageStoreMode: "docker-local",
          containerName: "nouva-app-svc_1-live",
          currentImage: {
            reference: "nouva-app:dep_prev",
            imageId: "img_prev",
            deploymentId: "dep_prev",
            commitHash: "prev123",
          },
          previousImage: {
            reference: "nouva-app:dep_older",
            imageId: "img_older",
            deploymentId: "dep_older",
            commitHash: "older123",
          },
          internalPort: 8080,
        },
      }
    );

    expect(docker.ensureContainer).toHaveBeenCalledWith(expect.anything(), true, { pull: false });
    expect(checkTcpConnect).toHaveBeenCalledWith("172.19.0.10", 8080, 1);
    expect(writeLocalTraefikRoute).toHaveBeenCalledWith(
      expect.anything(),
      "svc_1",
      {
        providedHostname: "app.up.nouva.cloud",
        customHostnames: [],
      },
      "http://nouva-app-svc_1-dep_1:8080"
    );
    expect(docker.removeContainer.mock.calls).toEqual([["nouva-app-svc_1-live", true]]);
    expect(docker.removeImage).toHaveBeenCalledWith("nouva-app:dep_older", true);
    expect(result.runtimeMetadata).toEqual(
      expect.objectContaining({
        imageStoreMode: "docker-local",
        currentImage: expect.objectContaining({
          reference: "127.0.0.1:5000/nouva-app:dep_1",
          imageId: "img_candidate",
          deploymentId: "dep_1",
          commitHash: "abc123",
        }),
        previousImage: expect.objectContaining({
          reference: "nouva-app:dep_prev",
          imageId: "img_prev",
          deploymentId: "dep_prev",
          commitHash: "prev123",
        }),
      })
    );
    expect(result.rollout).toEqual(
      expect.objectContaining({
        outcome: "committed",
        currentPhase: "retire",
      })
    );
  });

  test("removes the candidate and preserves the live runtime when readiness fails", async () => {
    const docker = createDockerMock();
    docker.ensureContainer.mockImplementation(async () => "ctr_candidate");
    docker.inspectContainer.mockImplementation(async (name: string) => {
      if (name === "nouva-app-svc_1-dep_1") {
        return {
          Id: "ctr_candidate",
          Name: name,
          State: {
            Running: false,
            Status: "exited",
          },
        };
      }

      return null;
    });

    const writeLocalTraefikRoute = mock(async () => {});

    await expect(
      deployAppImageWithDependencies(
        {
          ensureBaseRuntime: async () => undefined,
          checkTcpConnect: mock(async () => false),
          fetchImpl: mock(async () => Response.json([])) as typeof fetch,
          writeLocalTraefikRoute,
          deleteLocalTraefikRoute: mock(async () => {}),
        },
        docker as never,
        runtimeConfig,
        {
          ...appRuntimePayload,
          volume: null,
          rollout: createRolloutConfig(),
          runtimeMetadata: {
            containerName: "nouva-app-svc_1-live",
            internalPort: 8080,
          },
        }
      )
    ).rejects.toMatchObject({
      message: "Candidate container nouva-app-svc_1-dep_1 is not running (exited)",
      result: {
        rollout: expect.objectContaining({
          outcome: "aborted_before_cutover",
          liveRuntimePreserved: true,
        }),
      },
    });

    expect(writeLocalTraefikRoute).not.toHaveBeenCalled();
    expect(docker.removeContainer.mock.calls).toEqual([["nouva-app-svc_1-dep_1", true]]);
    expect(docker.removeImage).toHaveBeenCalledWith("127.0.0.1:5000/nouva-app:dep_1", true);
  });

  test("restores the previous route and keeps the live runtime when cutover verification fails", async () => {
    const docker = createDockerMock();
    docker.ensureContainer.mockImplementation(async () => "ctr_candidate");
    docker.inspectContainer.mockImplementation(async (name: string) => {
      if (name === "nouva-app-svc_1-dep_1") {
        return {
          Id: "ctr_candidate",
          Name: name,
          State: {
            Running: true,
          },
          NetworkSettings: {
            Networks: {
              "nouva-local": {
                IPAddress: "172.19.0.10",
              },
            },
          },
        };
      }

      return null;
    });

    let serviceUrl = "http://nouva-app-svc_1-live:8080";
    const writeLocalTraefikRoute = mock(
      async (_paths: unknown, _serviceId: string, _hostnames: string[], nextUrl: string) => {
        serviceUrl = nextUrl;
      }
    );
    const fetchImpl: typeof fetch = mock(async () =>
      Response.json([
        {
          name: "svc-svc_1@file",
          loadBalancer: {
            servers: [
              {
                url:
                  serviceUrl === "http://nouva-app-svc_1-dep_1:8080"
                    ? "http://wrong-target:8080"
                    : serviceUrl,
              },
            ],
          },
        },
      ])
    ) as typeof fetch;

    await expect(
      deployAppImageWithDependencies(
        {
          ensureBaseRuntime: async () => undefined,
          checkTcpConnect: mock(async () => true),
          fetchImpl,
          writeLocalTraefikRoute,
          deleteLocalTraefikRoute: mock(async () => {}),
        },
        docker as never,
        runtimeConfig,
        {
          ...appRuntimePayload,
          volume: null,
          rollout: createRolloutConfig(),
          runtimeMetadata: {
            containerName: "nouva-app-svc_1-live",
            internalPort: 8080,
          },
        }
      )
    ).rejects.toMatchObject({
      result: {
        rollout: expect.objectContaining({
          outcome: "rolled_back",
          rollbackCompleted: true,
          liveRuntimePreserved: true,
        }),
      },
    });

    expect(writeLocalTraefikRoute.mock.calls).toEqual([
      [
        expect.anything(),
        "svc_1",
        {
          providedHostname: "app.up.nouva.cloud",
          customHostnames: [],
        },
        "http://nouva-app-svc_1-dep_1:8080",
      ],
      [
        expect.anything(),
        "svc_1",
        {
          providedHostname: "app.up.nouva.cloud",
          customHostnames: [],
        },
        "http://nouva-app-svc_1-live:8080",
      ],
    ]);
    expect(docker.removeContainer.mock.calls).toEqual([["nouva-app-svc_1-dep_1", true]]);
  });

  test("fails fast for attached app volumes before touching the live runtime", async () => {
    const docker = createDockerMock();

    await expect(
      deployAppImageWithDependencies(
        {
          ensureBaseRuntime: async () => undefined,
          checkTcpConnect: mock(async () => true),
          fetchImpl: mock(async () => Response.json([])) as typeof fetch,
          writeLocalTraefikRoute: mock(async () => {}),
          deleteLocalTraefikRoute: mock(async () => {}),
        },
        docker as never,
        runtimeConfig,
        {
          ...appRuntimePayload,
          rollout: createRolloutConfig(),
          runtimeMetadata: {
            containerName: "nouva-app-svc_1-live",
            internalPort: 8080,
          },
        }
      )
    ).rejects.toMatchObject({
      message:
        "Safe app rollouts are blocked for services with attached volumes until single-writer support exists",
      result: {
        rollout: expect.objectContaining({
          outcome: "aborted_before_cutover",
          liveRuntimePreserved: true,
        }),
      },
    });

    expect(docker.ensureContainer).not.toHaveBeenCalled();
    expect(docker.removeContainer).not.toHaveBeenCalled();
  });
});

describe("buildDatabaseContainerSpec", () => {
  test("includes Docker resource limits for provisioned database containers", () => {
    const spec = buildDatabaseContainerSpec(databasePayload);

    expect(spec.resolved).toEqual(
      expect.objectContaining({
        mountPath: "/var/lib/postgresql",
        dataPath: "/var/lib/postgresql/pgdata",
      })
    );
    expect(spec.spec.hostConfig).toEqual(
      expect.objectContaining({
        Mounts: [
          expect.objectContaining({
            Source: "nouva-vol-vol_1",
            Target: "/var/lib/postgresql",
          }),
        ],
        NanoCpus: 1_500_000_000,
        Memory: 2 * 1024 * 1024 * 1024,
      })
    );
  });

  test("omits Docker CPU and memory limits for unlimited database containers", () => {
    const spec = buildDatabaseContainerSpec({
      ...databasePayload,
      resourceLimits: null,
    });

    expect(spec.spec.hostConfig).not.toHaveProperty("NanoCpus");
    expect(spec.spec.hostConfig).not.toHaveProperty("Memory");
  });

  test("stamps environment labels for database containers", () => {
    const spec = buildDatabaseContainerSpec(databasePayload);

    expect(spec.spec.labels).toEqual(
      expect.objectContaining({
        "nouva.environment.id": "env_1",
        "nouva.project.id": "proj_1",
        "nouva.service.id": "svc_1",
        "nouva.service.variant": "postgres",
        "nouva.kind": "database",
      })
    );
  });
});

describe("database runtime recreate paths", () => {
  test("applies Docker resource limits during database provision", async () => {
    const docker = createDockerMock();

    const result = await handleDatabaseProvision(docker as never, runtimeConfig, databasePayload);

    expect(docker.ensureContainer.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        hostConfig: expect.objectContaining({
          Mounts: [
            expect.objectContaining({
              Source: "nouva-vol-vol_1",
              Target: "/var/lib/postgresql",
            }),
          ],
          NanoCpus: 1_500_000_000,
          Memory: 2 * 1024 * 1024 * 1024,
        }),
      })
    );
    expect(result.runtimeMetadata).toEqual(
      expect.objectContaining({
        mountPath: "/var/lib/postgresql",
        dataPath: "/var/lib/postgresql/pgdata",
      })
    );
  });

  test("applies Docker resource limits when reapplying a database volume", async () => {
    const docker = createDockerMock();

    await handleApplyDatabaseVolume(docker as never, runtimeConfig, {
      ...databasePayload,
      resourceLimits: {
        memoryBytes: 1024 * 1024 * 1024,
      },
      runtimeMetadata: {
        containerName: "nouva-postgres-prev",
      },
    });

    expect(docker.removeContainer).toHaveBeenCalledWith("nouva-postgres-prev", true);
    expect(docker.ensureContainer.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        hostConfig: expect.objectContaining({
          Memory: 1024 * 1024 * 1024,
        }),
      })
    );
    expect(docker.ensureContainer.mock.calls[0]?.[0]?.hostConfig).not.toHaveProperty("NanoCpus");
  });

  test("attaches registry auth only for images hosted on the configured private registry", async () => {
    const docker = createDockerMock();

    await handleDatabaseProvision(
      docker as never,
      {
        ...runtimeConfig,
        privateRegistry: {
          host: "registry.nouva.sh",
          username: "srv_srv_1",
          password: "registry-password",
        },
      },
      {
        ...databasePayload,
        imageUrl: "registry.nouva.sh/nouva/postgres:17",
      }
    );

    expect(docker.ensureContainer.mock.calls[0]?.[2]).toEqual({
      auth: {
        host: "registry.nouva.sh",
        username: "srv_srv_1",
        password: "registry-password",
      },
    });

    docker.ensureContainer.mockClear();

    await handleDatabaseProvision(
      docker as never,
      {
        ...runtimeConfig,
        privateRegistry: {
          host: "registry.nouva.sh",
          username: "srv_srv_1",
          password: "registry-password",
        },
      },
      {
        ...databasePayload,
        imageUrl: "postgres:17",
      }
    );

    expect(docker.ensureContainer.mock.calls[0]?.[2]).toEqual({
      auth: undefined,
    });
  });

  test("restores PITR into the staged volume without touching the live container", async () => {
    const docker = createDockerMock();

    const result = await handleRestorePostgresPitr(docker as never, runtimeConfig, {
      ...databasePayload,
      sourceVolumeId: "vol_source",
      sourceVolumeName: "nouva-vol-vol_source",
      sourceMountPath: "/var/lib/postgresql",
      destination: {} as never,
      restoreTarget: "2026-03-25T00:00:00Z",
      runtimeMetadata: {
        containerName: "nouva-postgres-prev",
      },
    });

    expect(result).toEqual({
      statusMessage: "PITR restore ready to apply",
    });
    expect(docker.stopContainer).not.toHaveBeenCalled();
    expect(docker.ensureContainer).not.toHaveBeenCalled();
    expect(docker.createContainer).toHaveBeenCalledTimes(1);
    expect(docker.createContainer.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        image: "postgres:17",
        entrypoint: ["sh", "-c"],
        cmd: [expect.any(String)],
        hostConfig: expect.objectContaining({
          Mounts: [
            expect.objectContaining({
              Source: "nouva-vol-vol_1",
              Target: "/var/lib/postgresql",
            }),
          ],
        }),
        env: expect.arrayContaining(["NOUVA_DATA_PATH=/var/lib/postgresql/pgdata"]),
      })
    );
    const pitrScript = docker.createContainer.mock.calls[0]?.[0]?.cmd?.[0];
    expect(pitrScript).toContain('pgbackrest --stanza="$PGBACKREST_STANZA"');
    expect(pitrScript).toContain("--type=time");
    expect(pitrScript).toContain("--target-timeline=current");
    expect(pitrScript).toContain("/nouva/entrypoint.sh &");
    expect(pitrScript).toContain("pg_is_in_recovery()");
    expect(docker.createContainer.mock.calls[0]?.[0]?.env).toEqual(
      expect.arrayContaining(["RESTORE_TYPE=time", "NOUVA_STAGED_RESTORE=1"])
    );
    expect(
      docker.removeContainer.mock.calls.some((call) => call[0] === "nouva-postgres-prev")
    ).toBe(false);
  });

  test("initializes a missing pgBackRest stanza before the first backup", async () => {
    const docker = createDockerMock();

    await handleCreateVolumeBackup(docker as never, runtimeConfig, pgBackrestBackupPayload);

    expect(docker.createContainer).toHaveBeenCalledTimes(1);
    expect(docker.createContainer.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        image: "postgres:17",
        entrypoint: ["sh", "-c"],
        cmd: [
          expect.stringContaining(
            'pgbackrest --stanza="$PGBACKREST_STANZA" --log-level-console=info stanza-create'
          ),
        ],
        hostConfig: expect.objectContaining({
          Mounts: [
            expect.objectContaining({
              Source: "nouva-vol-vol_1",
              Target: "/var/lib/postgresql",
            }),
          ],
        }),
        env: expect.arrayContaining(["NOUVA_DATA_PATH=/var/lib/postgresql/pgdata"]),
      })
    );
  });

  test("selects the newest pgBackRest backup when annotations are unavailable", async () => {
    const docker = createDockerMock();
    docker.containerLogs.mockResolvedValue(
      `NOUVA_PGBACKREST_INFO:${JSON.stringify([
        {
          backup: [
            {
              label: "20260324-000000F",
              type: "full",
              timestamp: { stop: 1_774_310_400 },
            },
            {
              label: "20260325-000000F",
              type: "full",
              timestamp: { stop: 1_774_396_800 },
            },
          ],
        },
      ])}`
    );

    const result = await handleCreateVolumeBackup(
      docker as never,
      runtimeConfig,
      pgBackrestBackupPayload
    );

    expect(result.pgbackrestSet).toBe("20260325-000000F");
    expect(result.activePgbackrestSets).toEqual(["20260325-000000F", "20260324-000000F"]);
  });

  test("restores a named pgBackRest backup to consistency without a time target", async () => {
    const docker = createDockerMock();

    await handleRestoreVolumeBackup(docker as never, runtimeConfig, {
      ...pgBackrestRestorePayload,
      backupCompletedAt: null,
    });

    const task = docker.createContainer.mock.calls[0]?.[0];
    expect(task?.env).toEqual(
      expect.arrayContaining([
        "RESTORE_TYPE=immediate",
        "RESTORE_TARGET=",
        "RESTORE_SET=20260325-000000F",
        "NOUVA_STAGED_RESTORE=1",
      ])
    );
    expect(task?.cmd?.[0]).toContain("--type=immediate");
  });

  test("keeps timestamp-only pgBackRest backups on time recovery", async () => {
    const docker = createDockerMock();

    await handleRestoreVolumeBackup(docker as never, runtimeConfig, {
      ...pgBackrestRestorePayload,
      pgbackrestSet: null,
    });

    const task = docker.createContainer.mock.calls[0]?.[0];
    expect(task?.env).toEqual(
      expect.arrayContaining([
        "RESTORE_TYPE=time",
        "RESTORE_TARGET=2026-03-25T00:00:00Z",
        "RESTORE_SET=",
        "NOUVA_STAGED_RESTORE=1",
      ])
    );
    expect(task?.cmd?.[0]).toContain("--target-timeline=current");
  });

  test("uses the installed agent image for snapshot backup tasks", async () => {
    const docker = createDockerMock();
    process.env.NOUVA_AGENT_IMAGE = "registry.nouva.sh/nouva/nouva-agent:v0.4.10";

    await handleCreateVolumeBackup(
      docker as never,
      {
        ...runtimeConfig,
        privateRegistry: {
          host: "registry.nouva.sh",
          username: "srv_srv_1",
          password: "registry-password",
        },
      },
      snapshotBackupPayload
    );

    expect(docker.pullImage).toHaveBeenCalledWith("registry.nouva.sh/nouva/nouva-agent:v0.4.10", {
      host: "registry.nouva.sh",
      username: "srv_srv_1",
      password: "registry-password",
    });
    expect(docker.createContainer.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        image: "registry.nouva.sh/nouva/nouva-agent:v0.4.10",
        cmd: [expect.any(String), expect.any(String), expect.any(String)],
        hostConfig: expect.objectContaining({
          Mounts: [
            expect.objectContaining({
              Source: "nouva-vol-vol_redis_1",
              Target: "/source",
            }),
          ],
        }),
      })
    );
  });

  test("uses private registry auth when a PITR helper image is hosted on the private registry", async () => {
    const docker = createDockerMock();

    await handleRestorePostgresPitr(
      docker as never,
      {
        ...runtimeConfig,
        privateRegistry: {
          host: "registry.nouva.sh",
          username: "srv_srv_1",
          password: "registry-password",
        },
      },
      {
        ...databasePayload,
        sourceVolumeId: "vol_source",
        sourceVolumeName: "nouva-vol-vol_source",
        sourceMountPath: "/var/lib/postgresql",
        imageUrl: "registry.nouva.sh/nouva/postgres:17",
        destination: {} as never,
        restoreTarget: "2026-03-25T00:00:00Z",
      }
    );

    expect(docker.pullImage).toHaveBeenCalledWith("registry.nouva.sh/nouva/postgres:17", {
      host: "registry.nouva.sh",
      username: "srv_srv_1",
      password: "registry-password",
    });
  });

  test("does not attach private registry auth when a PITR helper image is public", async () => {
    const docker = createDockerMock();

    await handleRestorePostgresPitr(
      docker as never,
      {
        ...runtimeConfig,
        privateRegistry: {
          host: "registry.nouva.sh",
          username: "srv_srv_1",
          password: "registry-password",
        },
      },
      {
        ...databasePayload,
        sourceVolumeId: "vol_source",
        sourceVolumeName: "nouva-vol-vol_source",
        sourceMountPath: "/var/lib/postgresql",
        imageUrl: "postgres:17",
        destination: {} as never,
        restoreTarget: "2026-03-25T00:00:00Z",
      }
    );

    expect(docker.pullImage).toHaveBeenCalledWith("postgres:17", undefined);
  });

  test("deduplicates overlapping runtime log batches and preserves offsets", () => {
    const firstPass = normalizeRuntimeLogEntries(
      [
        {
          type: "stdout",
          timestamp: "2026-03-26T12:00:00.000Z",
          line: "starting postgres",
        },
        {
          type: "stderr",
          timestamp: "2026-03-26T12:00:01.000Z",
          line: "database system is ready to accept connections",
        },
      ],
      null
    );

    expect(firstPass.entries).toEqual([
      {
        type: "stdout",
        line: "starting postgres",
        timestamp: Date.parse("2026-03-26T12:00:00.000Z"),
        offset: 0,
      },
      {
        type: "stderr",
        line: "database system is ready to accept connections",
        timestamp: Date.parse("2026-03-26T12:00:01.000Z"),
        offset: 1,
      },
    ]);

    const secondPass = normalizeRuntimeLogEntries(
      [
        {
          type: "stderr",
          timestamp: "2026-03-26T12:00:01.000Z",
          line: "database system is ready to accept connections",
        },
        {
          type: "stdout",
          timestamp: "2026-03-26T12:00:02.000Z",
          line: "checkpoint complete",
        },
      ],
      firstPass.cursor
    );

    expect(secondPass.entries).toEqual([
      {
        type: "stdout",
        line: "checkpoint complete",
        timestamp: Date.parse("2026-03-26T12:00:02.000Z"),
        offset: 2,
      },
    ]);
  });
});

describe("resolveServiceContainerIdentifier", () => {
  test("prefers explicit container names over runtime metadata", () => {
    expect(
      resolveServiceContainerIdentifier({
        containerName: "nouva-postgres-svc_1",
        runtimeMetadata: {
          containerId: "ctr_1",
          containerName: "legacy-name",
        },
      })
    ).toBe("nouva-postgres-svc_1");
  });
});

describe("verified volume cleanup", () => {
  test("returns delete proof only after Docker confirms the volume is absent", async () => {
    const docker = createDockerMock();

    const result = await handleDeleteVolume(docker as never, {
      projectId: "proj_1",
      volumeId: "vol_1",
      volumeName: "nouva-vol-vol_1",
    });

    expect(docker.removeVolume).toHaveBeenCalledWith("nouva-vol-vol_1", true);
    expect(docker.inspectVolume).toHaveBeenCalledWith("nouva-vol-vol_1");
    expect(result.cleanupProof).toEqual({
      version: 1,
      kind: "delete_volume",
      volume: { name: "nouva-vol-vol_1", absent: true },
    });
  });

  test("does not emit proof when Docker still reports the volume", async () => {
    const docker = createDockerMock();
    docker.inspectVolume.mockResolvedValueOnce({ Name: "nouva-vol-vol_1" });

    await expect(
      handleDeleteVolume(docker as never, {
        projectId: "proj_1",
        volumeId: "vol_1",
        volumeName: "nouva-vol-vol_1",
      })
    ).rejects.toThrow("still exists after cleanup");
  });

  test("propagates a volume-in-use conflict without inspecting absence", async () => {
    const docker = createDockerMock();
    const conflict = new DockerApiError(
      409,
      "DELETE",
      "/v1.51/volumes/nouva-vol-vol_1",
      "volume is in use"
    );
    docker.removeVolume.mockRejectedValueOnce(conflict);

    await expect(
      handleDeleteVolume(docker as never, {
        projectId: "proj_1",
        volumeId: "vol_1",
        volumeName: "nouva-vol-vol_1",
      })
    ).rejects.toBe(conflict);
    expect(docker.inspectVolume).not.toHaveBeenCalled();
  });
});

describe("verified service cleanup", () => {
  test("retries partial cleanup and removes distinct tags sharing one image ID", async () => {
    const docker = createDockerMock();
    const previousImageFailure = new Error("Docker daemon became unavailable");
    let shouldFailPreviousImage = true;
    docker.inspectImage.mockResolvedValue(null);
    docker.removeImage.mockImplementation(async (reference: string) => {
      if (reference === "nouva-app:previous" && shouldFailPreviousImage) {
        shouldFailPreviousImage = false;
        throw previousImageFailure;
      }
    });
    const payload = {
      projectId: "proj_1",
      serviceId: "svc_1",
      serviceName: "app",
      serviceType: "app" as const,
      containerName: "nouva-app-svc_1",
      runtimeMetadata: {
        imageStoreMode: "docker-local" as const,
        currentImage: {
          reference: "nouva-app:current",
          imageId: "sha256:shared",
        },
        previousImage: {
          reference: "nouva-app:previous",
          imageId: "sha256:shared",
        },
      },
    };

    await expect(handleDeleteService(docker as never, payload)).rejects.toBe(previousImageFailure);
    const result = await handleDeleteService(docker as never, payload);

    expect(docker.removeImage.mock.calls.map(([reference]) => reference)).toEqual([
      "nouva-app:current",
      "nouva-app:previous",
      "nouva-app:current",
      "nouva-app:previous",
    ]);
    expect(result.cleanupProof).toEqual({
      version: 1,
      kind: "delete_service",
      container: { identifier: "nouva-app-svc_1", absent: true },
      retainedImages: [
        { reference: "nouva-app:current", absent: true },
        { reference: "nouva-app:previous", absent: true },
      ],
    });
  });
});

describe("verified volume wipe", () => {
  test("proves detached volume absence before creating and proving a replacement", async () => {
    const docker = createDockerMock();
    const events: string[] = [];
    let inspectionCount = 0;
    docker.removeVolume.mockImplementation(async () => {
      events.push("remove");
    });
    docker.inspectVolume.mockImplementation(async () => {
      inspectionCount += 1;
      events.push(inspectionCount === 1 ? "inspect-absent" : "inspect-present");
      return inspectionCount === 1 ? null : { Name: "nouva-vol-vol_1" };
    });
    docker.createVolume.mockImplementation(async () => {
      events.push("create");
    });

    const result = await handleWipeVolume(
      docker as never,
      {},
      {
        projectId: "proj_1",
        volumeId: "vol_1",
        volumeName: "nouva-vol-vol_1",
      }
    );

    expect(events).toEqual(["remove", "inspect-absent", "create", "inspect-present"]);
    expect(result.cleanupProof).toEqual({
      version: 1,
      kind: "wipe_volume",
      previousContainer: { identifier: null, absent: true },
      previousVolume: { name: "nouva-vol-vol_1", absent: true },
      replacementVolume: { name: "nouva-vol-vol_1", present: true },
    });
  });

  test("removes a replacement container left by a partial attached wipe before retrying", async () => {
    const docker = createDockerMock();
    const deterministicContainerName = "nouva-postgres-svc_1";
    let replacementContainerPresent = false;
    let volumePresent = true;
    let volumeInspectionCount = 0;

    docker.removeContainer.mockImplementation(async (identifier: string) => {
      if (identifier === deterministicContainerName) {
        replacementContainerPresent = false;
      }
    });
    docker.inspectContainer.mockImplementation(async (identifier: string) =>
      identifier === deterministicContainerName && replacementContainerPresent
        ? ({ Id: "ctr_replacement" } as never)
        : null
    );
    docker.removeVolume.mockImplementation(async () => {
      if (replacementContainerPresent) {
        throw new Error("volume is in use");
      }
      volumePresent = false;
    });
    docker.createVolume.mockImplementation(async () => {
      volumePresent = true;
    });
    docker.ensureContainer.mockImplementation(async () => {
      replacementContainerPresent = true;
      return "ctr_replacement";
    });
    docker.inspectVolume.mockImplementation(async () => {
      volumeInspectionCount += 1;
      if (volumeInspectionCount === 2) {
        return null;
      }
      return volumePresent ? { Name: "nouva-vol-vol_1" } : null;
    });
    const payload = {
      ...databasePayload,
      runtimeMetadata: {
        containerId: "ctr_old",
      },
    };

    await expect(handleWipeVolume(docker as never, runtimeConfig, payload)).rejects.toThrow(
      "Replacement Docker volume nouva-vol-vol_1 was not created"
    );
    expect(replacementContainerPresent).toBe(true);

    const result = await handleWipeVolume(docker as never, runtimeConfig, payload);

    expect(docker.removeContainer.mock.calls).toEqual([
      ["ctr_old", true],
      [deterministicContainerName, true],
      ["ctr_old", true],
      [deterministicContainerName, true],
    ]);
    expect(result.cleanupProof).toEqual({
      version: 1,
      kind: "wipe_volume",
      previousContainer: { identifier: "ctr_old", absent: true },
      previousVolume: { name: "nouva-vol-vol_1", absent: true },
      replacementVolume: { name: "nouva-vol-vol_1", present: true },
    });
  });
});
