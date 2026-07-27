import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ALLOY_CONFIG_HASH_LABEL,
  ALLOY_CONTAINER_NAME,
  ALLOY_HTTP_HOST,
  ALLOY_HTTP_PORT,
  buildAlloyContainerSpec,
  buildAlloyValidationContainerSpec,
  collectAlloyValidationChecks,
  createAlloyStateHash,
  ensureAlloyRuntime,
  getAlloyRuntimePaths,
  renderAlloyConfig,
  resetAlloyRuntimeState,
} from "./alloy-runtime.js";
import type { DockerContainerInspection } from "./docker-api.js";
import type { AgentRuntimeConfig } from "./protocol.js";

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
    postgresObservability: true,
    alloyObservability: true,
  },
  localRegistryHost: "127.0.0.1",
  localRegistryPort: 5000,
  localTraefikNetwork: "nouva-ingress",
  observability: {
    enabled: true,
    organizationId: "org_123",
    alloyImage: "grafana/alloy:v1.17.1",
    scrapeIntervalSeconds: 45,
    collectorScope: "services_traefik_and_workers",
    noneLabelValue: "__none__",
  },
};

function createAlloyInput(dataDir: string) {
  return {
    dataDir,
    dataVolume: "nouva-agent-data",
    serverId: "srv_1",
    apiUrl: "https://api.nouva.sh",
    agentToken: "agent-token",
    config: runtimeConfig,
  };
}

function createAlloyInspection(input: {
  image?: string;
  running?: boolean;
  stateHash?: string;
  binds?: string[];
}): DockerContainerInspection {
  return {
    Id: ALLOY_CONTAINER_NAME,
    Name: ALLOY_CONTAINER_NAME,
    State: {
      Running: input.running ?? true,
    },
    HostConfig: {
      Binds: input.binds ?? [
        "/var/run/docker.sock:/var/run/docker.sock",
        "/:/rootfs:ro",
        "/sys:/sys:ro",
        "/var/run:/var/run:ro",
        "/var/lib/docker:/var/lib/docker:ro",
        "nouva-agent-data:/var/lib/nouva-agent",
      ],
      RestartPolicy: {
        Name: "unless-stopped",
      },
      PortBindings: {
        [`${ALLOY_HTTP_PORT}/tcp`]: [
          {
            HostIp: ALLOY_HTTP_HOST,
            HostPort: String(ALLOY_HTTP_PORT),
          },
        ],
      },
      Privileged: true,
    },
    Config: {
      Image: input.image ?? runtimeConfig.observability.alloyImage,
      Labels: {
        [ALLOY_CONFIG_HASH_LABEL]: input.stateHash ?? "state-hash",
      },
    },
  };
}

describe("alloy-runtime", () => {
  let tempDir = "";

  afterEach(async () => {
    resetAlloyRuntimeState();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  test("renders an Alloy config with filters, reserved labels, and bearer-auth writes", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-alloy-"));

    const config = renderAlloyConfig(createAlloyInput(tempDir));

    expect(config).toContain('"https://api.nouva.sh/api/agent/observability/logs"');
    expect(config).toContain('"https://api.nouva.sh/api/agent/observability/metrics"');
    expect(config).toContain('"agent-token"');
    expect(config).toContain('min_backoff_period  = "1s"');
    expect(config).toContain('max_backoff_period  = "1m"');
    expect(config).toContain("max_backoff_retries = 10080");
    expect(config).toContain("retry_on_http_429   = true");
    expect(config).toContain('capacity          = "64MiB"');
    expect(config).toContain("min_shards        = 1");
    expect(config).toContain("block_on_overflow = true");
    expect(config).toContain('drain_timeout     = "1m"');
    expect(config).toContain("enabled         = true");
    expect(config).toContain('max_segment_age = "168h"');
    expect(config).toContain('regex         = "app|database|traefik|worker|worker_job"');
    expect(config).toContain('target_label = "organization_id"');
    expect(config).toContain('target_label = "environment_id"');
    expect(config).toContain('replacement  = "__none__"');
    expect(config).toContain("allowlisted_container_labels = [");
  });

  test("preserves worker identity in Loki and Mimir", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-alloy-"));

    const config = renderAlloyConfig(createAlloyInput(tempDir));
    const cadvisorOffset = config.indexOf('prometheus.exporter.cadvisor "nouva"');
    const lokiConfig = config.slice(0, cadvisorOffset);
    const metricConfig = config.slice(cadvisorOffset);

    expect(lokiConfig).toContain("__meta_docker_container_label_nouva_replica_index");
    expect(lokiConfig).toContain("__meta_docker_container_label_nouva_schedule_id");
    expect(lokiConfig).toContain("__meta_docker_container_label_nouva_schedule_run_id");
    expect(lokiConfig).toContain('target_label = "schedule_run_id"');
    expect(lokiConfig).toContain('target_label  = "container_name"');
    expect(metricConfig).toContain('"nouva.replica.index"');
    expect(metricConfig).toContain('"nouva.schedule.id"');
    expect(metricConfig).toContain('"nouva.schedule.run.id"');
    expect(metricConfig).toContain('target_label = "replica_index"');
    expect(metricConfig).toContain('target_label = "schedule_id"');
    expect(metricConfig).toContain('target_label = "schedule_run_id"');
    expect(metricConfig).toContain('"container_label_nouva_schedule_run_id"');
    expect(metricConfig).toContain('target_label  = "container_name"');
  });

  test("builds the managed Alloy container spec with required mounts and localhost health port", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-alloy-"));

    const config = renderAlloyConfig(createAlloyInput(tempDir));
    const spec = buildAlloyContainerSpec(createAlloyInput(tempDir), {
      stateHash: createAlloyStateHash(config),
    });

    expect(spec.image).toBe("grafana/alloy:v1.17.1");
    expect(spec.cmd).toContain("--stability.level=experimental");
    expect(spec.hostConfig).toEqual(
      expect.objectContaining({
        Binds: expect.arrayContaining([
          "/var/run/docker.sock:/var/run/docker.sock",
          "/:/rootfs:ro",
          "/sys:/sys:ro",
          "/var/run:/var/run:ro",
          "/var/lib/docker:/var/lib/docker:ro",
          "nouva-agent-data:/var/lib/nouva-agent",
        ]),
        RestartPolicy: {
          Name: "unless-stopped",
        },
        Privileged: true,
        PortBindings: {
          [`${ALLOY_HTTP_PORT}/tcp`]: [
            {
              HostIp: "127.0.0.1",
              HostPort: "12345",
            },
          ],
        },
      })
    );

    expect(buildAlloyValidationContainerSpec(createAlloyInput(tempDir))).toEqual(
      expect.objectContaining({
        image: "grafana/alloy:v1.17.1",
        cmd: [
          "validate",
          "--stability.level=experimental",
          "/var/lib/nouva-agent/alloy/config.alloy.candidate",
        ],
        hostConfig: {
          Binds: ["nouva-agent-data:/var/lib/nouva-agent:ro"],
          NetworkMode: "none",
        },
      })
    );
  });

  test("reconciles Alloy state and reports healthy validation checks", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-alloy-"));
    const paths = getAlloyRuntimePaths(tempDir);
    const input = createAlloyInput(tempDir);
    const config = renderAlloyConfig(input);
    const stateHash = createAlloyStateHash(config);
    const dockerState: { inspection: DockerContainerInspection | null } = {
      inspection: null,
    };

    const docker = {
      inspectContainer: mock(async () => dockerState.inspection),
      inspectImage: mock(async () => ({ Id: "img_1" })),
      pullImage: mock(async () => undefined),
      createContainer: mock(async () => "alloy-validation"),
      startContainer: mock(async () => undefined),
      waitContainer: mock(async () => 0),
      containerLogs: mock(async () => ""),
      removeContainer: mock(async (name: string) => {
        if (name === ALLOY_CONTAINER_NAME) {
          dockerState.inspection = null;
        }
      }),
      ensureContainer: mock(
        async (spec: { image: string; labels?: Record<string, string>; hostConfig?: unknown }) => {
          dockerState.inspection = createAlloyInspection({
            image: spec.image,
            stateHash: spec.labels?.[ALLOY_CONFIG_HASH_LABEL] ?? stateHash,
          });
          return ALLOY_CONTAINER_NAME;
        }
      ),
    };

    const fetchImpl: typeof fetch = mock(
      async () =>
        new Response("metrics", {
          status: 200,
        })
    ) as typeof fetch;

    await ensureAlloyRuntime(docker, input, {
      paths,
      fetchImpl,
      timeoutMs: 100,
      intervalMs: 1,
    });

    const persistedConfig = await readFile(paths.configPath, "utf8");
    expect(persistedConfig).toContain("/api/agent/observability/logs");
    expect(docker.pullImage).toHaveBeenCalledWith("grafana/alloy:v1.17.1");
    expect(docker.createContainer).toHaveBeenCalledWith(buildAlloyValidationContainerSpec(input));
    expect(docker.ensureContainer).toHaveBeenCalledTimes(1);
    expect(docker.ensureContainer).toHaveBeenCalledWith(expect.anything(), false, {
      pull: false,
    });

    const checks = await collectAlloyValidationChecks(
      {
        inspectContainer: docker.inspectContainer,
        inspectImage: docker.inspectImage,
      },
      input,
      {
        paths,
        fetchImpl,
      }
    );

    expect(checks).toEqual([
      expect.objectContaining({ key: "alloy-image", status: "pass" }),
      expect.objectContaining({ key: "alloy-container", status: "pass" }),
      expect.objectContaining({ key: "alloy-config", status: "pass" }),
      expect.objectContaining({ key: "alloy-health", status: "pass" }),
      expect.objectContaining({ key: "alloy-mounts", status: "pass" }),
    ]);
  });

  test("keeps the running collector when candidate config validation fails", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-alloy-"));
    const input = createAlloyInput(tempDir);
    const currentInspection = createAlloyInspection({
      image: "grafana/alloy:v1.16.1",
      stateHash: "old-state",
    });
    const removeContainer = mock(async () => undefined);
    const docker = {
      inspectContainer: mock(async () => currentInspection),
      inspectImage: mock(async () => ({ Id: "img_1" })),
      pullImage: mock(async () => undefined),
      createContainer: mock(async () => "alloy-validation"),
      startContainer: mock(async () => undefined),
      waitContainer: mock(async () => 1),
      containerLogs: mock(async () => "invalid queue_config"),
      removeContainer,
      ensureContainer: mock(async () => ALLOY_CONTAINER_NAME),
    };

    await expect(
      ensureAlloyRuntime(docker, input, {
        paths: getAlloyRuntimePaths(tempDir),
        timeoutMs: 100,
        intervalMs: 1,
      })
    ).rejects.toThrow("Alloy configuration validation failed: invalid queue_config");

    expect(removeContainer).not.toHaveBeenCalledWith(ALLOY_CONTAINER_NAME, true);
    expect(docker.ensureContainer).not.toHaveBeenCalled();
  });
});
