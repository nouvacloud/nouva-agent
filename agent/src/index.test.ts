import { describe, expect, mock, test } from "bun:test";
import agentPackageJson from "../package.json" with { type: "json" };
import type { DeployAppImageInput } from "./app-build-runtime.js";
import { buildAndDeployAppWithDependencies } from "./app-build-runtime.js";
import {
  ApiRequestError,
  buildAppContainerSpec,
  buildDatabaseContainerSpec,
  buildUpdateAgentRuntimeEnv,
  deployAppImageWithDependencies,
  handleApplyDatabaseVolume,
  handleDatabaseProvision,
  handleRestorePostgresPitr,
  normalizeRuntimeLogEntries,
  prepareAppBuildkitRuntime,
  resolveReportedAgentVersion,
  resolveServiceContainerIdentifier,
  shouldStopRetryingAgentWorkMutation,
} from "./index.js";
import type {
  AgentRuntimeConfig,
  AppDeployPayload,
  AppRolloutConfig,
  DatabaseProvisionPayload,
} from "./protocol.js";

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
    connectNetwork: mock(async () => {}),
    inspectContainer: mock(async () => null),
    removeContainer: mock(async () => {}),
    stopContainer: mock(async () => {}),
    pullImage: mock(async () => {}),
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
        "NOUVA_AGENT_TARGET_IMAGE=ghcr.io/nouvacloud/nouva-agent:latest",
      ],
      envInheritFlags:
        "-e NOUVA_AGENT_DATA_VOLUME -e NOUVA_API_URL -e NOUVA_SERVER_ID -e NOUVA_AGENT_TARGET_IMAGE",
    });
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
          containerName: "nouva-app-svc_1-live",
          internalPort: 8080,
        },
      }
    );

    expect(checkTcpConnect).toHaveBeenCalledWith("172.19.0.10", 8080, 1);
    expect(writeLocalTraefikRoute).toHaveBeenCalledWith(
      expect.anything(),
      "svc_1",
      ["app.nouva.cloud"],
      "http://nouva-app-svc_1-dep_1:8080"
    );
    expect(docker.removeContainer.mock.calls).toEqual([["nouva-app-svc_1-live", true]]);
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
      [expect.anything(), "svc_1", ["app.nouva.cloud"], "http://nouva-app-svc_1-dep_1:8080"],
      [expect.anything(), "svc_1", ["app.nouva.cloud"], "http://nouva-app-svc_1-live:8080"],
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
