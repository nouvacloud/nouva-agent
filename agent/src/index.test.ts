import { describe, expect, mock, test } from "bun:test";
import type { DeployAppImageInput } from "./app-build-runtime.js";
import { buildAndDeployAppWithDependencies } from "./app-build-runtime.js";
import {
  buildAppContainerSpec,
  buildDatabaseContainerSpec,
  handleApplyDatabaseVolume,
  handleDatabaseProvision,
  handleRestorePostgresPitr,
  normalizeRuntimeLogEntries,
  prepareAppBuildkitRuntime,
  resolveServiceContainerIdentifier,
} from "./index.js";
import type { AgentRuntimeConfig, AppDeployPayload, DatabaseProvisionPayload } from "./protocol.js";

const runtimeConfig: AgentRuntimeConfig = {
  heartbeatIntervalSeconds: 30,
  pollIntervalSeconds: 10,
  leaseTtlSeconds: 120,
  metricsIntervalSeconds: 30,
  postgresObservabilityIntervalSeconds: 30,
  ingressMode: "local_traefik",
  buildkitMode: "docker-container",
  capabilities: {
    dockerApi: true,
    buildkit: true,
    localRegistry: true,
    localTraefik: true,
    postgresObservability: true,
  },
  localRegistryHost: "127.0.0.1",
  localRegistryPort: 5000,
  localTraefikNetwork: "nouva-local",
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
  volumeId: "vol_1",
  volumeName: "nouva-vol-vol_1",
  mountPath: "/var/lib/postgresql",
  imageUrl: "postgres:17",
  envVars: {
    POSTGRES_USER: "nouva_user",
    POSTGRES_PASSWORD: "super-secret",
  },
  containerArgs: [],
  dataPath: "/var/lib/postgresql",
  internalPort: 5432,
  storageSizeGb: 20,
  externalHost: null,
  externalPort: null,
  publicAccessEnabled: false,
  resourceLimits,
  runtimeMetadata: null,
};

function createDockerMock() {
  return {
    ensureNetwork: mock(async () => {}),
    createVolume: mock(async () => {}),
    ensureContainer: mock(async () => "ctr_1"),
    removeContainer: mock(async () => {}),
    stopContainer: mock(async () => {}),
    pullImage: mock(async () => {}),
    createContainer: mock(async () => "task_1"),
    startContainer: mock(async () => {}),
    waitContainer: mock(async () => 0),
    containerLogs: mock(async () => ""),
  };
}

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
});

describe("buildDatabaseContainerSpec", () => {
  test("includes Docker resource limits for provisioned database containers", () => {
    const spec = buildDatabaseContainerSpec(databasePayload);

    expect(spec.spec.hostConfig).toEqual(
      expect.objectContaining({
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
});

describe("database runtime recreate paths", () => {
  test("applies Docker resource limits during database provision", async () => {
    const docker = createDockerMock();

    await handleDatabaseProvision(docker as never, databasePayload);

    expect(docker.ensureContainer.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        hostConfig: expect.objectContaining({
          NanoCpus: 1_500_000_000,
          Memory: 2 * 1024 * 1024 * 1024,
        }),
      })
    );
  });

  test("applies Docker resource limits when reapplying a database volume", async () => {
    const docker = createDockerMock();

    await handleApplyDatabaseVolume(docker as never, {
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

  test("restores PITR into the staged volume without touching the live container", async () => {
    const docker = createDockerMock();

    const result = await handleRestorePostgresPitr(docker as never, {
      ...databasePayload,
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
    expect(
      docker.removeContainer.mock.calls.some((call) => call[0] === "nouva-postgres-prev")
    ).toBe(false);
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
