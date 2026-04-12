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
    runtimeLogs: false,
    postgresObservability: true,
    alloyObservability: true,
  },
  localRegistryHost: "127.0.0.1",
  localRegistryPort: 5000,
  localTraefikNetwork: "nouva-ingress",
  observability: {
    enabled: true,
    organizationId: "org_123",
    alloyImage: "grafana/alloy:v1.8.3",
    scrapeIntervalSeconds: 45,
    collectorScope: "services_and_traefik",
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

    expect(config).toContain('url          = "https://api.nouva.sh/api/agent/observability/logs"');
    expect(config).toContain(
      'url          = "https://api.nouva.sh/api/agent/observability/metrics"'
    );
    expect(config).toContain('bearer_token = "agent-token"');
    expect(config).toContain('regex         = "app|database|traefik"');
    expect(config).toContain('target_label = "organization_id"');
    expect(config).toContain('target_label = "environment_id"');
    expect(config).toContain('replacement  = "__none__"');
    expect(config).toContain("allowlisted_container_labels = [");
  });

  test("builds the managed Alloy container spec with required mounts and localhost health port", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-alloy-"));

    const config = renderAlloyConfig(createAlloyInput(tempDir));
    const spec = buildAlloyContainerSpec(createAlloyInput(tempDir), {
      stateHash: createAlloyStateHash(config),
    });

    expect(spec.image).toBe("grafana/alloy:v1.8.3");
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
      removeContainer: mock(async () => {
        dockerState.inspection = null;
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
    expect(docker.ensureContainer).toHaveBeenCalledTimes(1);

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
});
