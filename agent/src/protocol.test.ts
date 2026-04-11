import { afterEach, describe, expect, test } from "bun:test";
import {
  AGENT_WORK_KINDS,
  type AgentHeartbeatRequest,
  type AgentHeartbeatResponse,
  type AgentLeaseRequest,
  type AgentLeaseResponse,
  type AgentMetricsRequest,
  type AgentPostgresObservabilityRequest,
  type AgentRegistrationRequest,
  type AgentRegistrationResponse,
  type AgentWorkMutationRequest,
  canLeaseWorkItem,
  getAgentRuntimeConfig,
  negotiateDockerApiVersion,
  parseDockerStatsSnapshot,
  parseHostMetricsSnapshot,
} from "./protocol.js";
import { buildTraefikRouteConfig } from "./traefik-runtime.js";

const runtimeEnvKeys = [
  "NOUVA_AGENT_HEARTBEAT_INTERVAL_SECONDS",
  "NOUVA_AGENT_POLL_INTERVAL_SECONDS",
  "NOUVA_AGENT_LEASE_TTL_SECONDS",
  "NOUVA_AGENT_METRICS_INTERVAL_SECONDS",
  "NOUVA_AGENT_POSTGRES_OBSERVABILITY_INTERVAL_SECONDS",
  "NOUVA_AGENT_LOCAL_REGISTRY_HOST",
  "NOUVA_AGENT_LOCAL_REGISTRY_PORT",
  "NOUVA_AGENT_INGRESS_NETWORK",
] as const;

const originalRuntimeEnv = Object.fromEntries(
  runtimeEnvKeys.map((key) => [key, process.env[key]])
) as Record<(typeof runtimeEnvKeys)[number], string | undefined>;

describe("agent protocol", () => {
  afterEach(() => {
    for (const key of runtimeEnvKeys) {
      const value = originalRuntimeEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  test("serializes the agent wire contract fixtures", () => {
    const registrationRequest = {
      serverId: "srv_123",
      registrationToken: "reg_123",
      hostname: "host-1",
      operatingSystem: "ubuntu",
      architecture: "x64",
      dockerVersion: "27.0.0",
      agentVersion: "0.1.0",
      publicIp: "203.0.113.10",
      cpuCores: 4,
      memoryBytes: 16_000_000_000,
      diskBytesAvailable: 500_000_000_000,
      latestValidationReport: {
        checkedAt: new Date().toISOString(),
        summary: { pass: 1, warn: 0, fail: 0 },
        checks: [{ key: "docker", label: "Docker", status: "pass", message: "ok" }],
      },
      capabilities: {
        dockerApi: true,
      },
    } satisfies AgentRegistrationRequest;

    const registrationResponse = {
      serverId: "srv_123",
      agentToken: "agent_123",
      config: getAgentRuntimeConfig(),
    } satisfies AgentRegistrationResponse;

    const heartbeatRequest = {
      ...registrationRequest,
    } satisfies AgentHeartbeatRequest;

    const heartbeatResponse = {
      ok: true,
      config: getAgentRuntimeConfig(),
    } satisfies AgentHeartbeatResponse;

    const leaseRequest = {
      serverId: "srv_123",
      limit: 5,
    } satisfies AgentLeaseRequest;

    const leaseResponse = {
      config: getAgentRuntimeConfig(),
      workItems: [],
    } satisfies AgentLeaseResponse;

    const mutationRequest = {
      serverId: "srv_123",
      leaseId: "lease_123",
      result: { ok: true },
      errorMessage: null,
    } satisfies AgentWorkMutationRequest;

    const metricsRequest = {
      serverId: "srv_123",
      server: {
        collectedAt: new Date().toISOString(),
      },
      services: [],
    } satisfies AgentMetricsRequest;

    const postgresObservabilityRequest = {
      serverId: "srv_123",
      samples: [
        {
          serviceId: "svc_123",
          collectedAt: new Date().toISOString(),
          status: "success",
          errorMessage: null,
          extensionStatus: {
            pgStatMonitor: true,
            pgCron: false,
          },
          activeSessions: [{ state: "active", count: 2 }],
          slowQueries: [],
        },
      ],
    } satisfies AgentPostgresObservabilityRequest;

    const roundTrips = [
      registrationRequest,
      registrationResponse,
      heartbeatRequest,
      heartbeatResponse,
      leaseRequest,
      leaseResponse,
      mutationRequest,
      metricsRequest,
      postgresObservabilityRequest,
    ].map((value) => JSON.parse(JSON.stringify(value)));

    expect(roundTrips).toHaveLength(9);
    expect(roundTrips[0]).toEqual(registrationRequest);
    expect(roundTrips[7]).toEqual(metricsRequest);
    expect(roundTrips[8]).toEqual(postgresObservabilityRequest);
  });

  test("includes the backup and PITR work kinds in the wire contract", () => {
    expect(AGENT_WORK_KINDS).toEqual(
      expect.arrayContaining([
        "create_volume_backup",
        "delete_volume_backup",
        "restore_volume_backup",
        "restore_postgres_pitr",
        "expire_volume_backup_repository",
      ])
    );
  });

  test("round-trips a hydrated backup work payload", () => {
    const payload = {
      projectId: "proj_1",
      serviceId: "svc_1",
      serviceName: "main-db",
      variant: "postgres",
      version: "17",
      volumeId: "vol_1",
      volumeName: "nouva-vol-vol_1",
      mountPath: "/var/lib/postgresql",
      backupId: "bkp_1",
      kind: "MANUAL",
      scheduleType: null,
      engine: "pgbackrest",
      pgbackrestType: "full",
      destination: {
        id: "platform-default",
        type: "s3",
        bucket: "nouva-backups",
        endpoint: "https://s3.example.com",
        region: "us-east-1",
        accessKeyId: "key-id",
        secretAccessKey: "secret-key",
        pathStyle: true,
        verifyTls: true,
        pgbackrestRepoType: "s3",
        pgbackrestCipherType: null,
        pgbackrestCipherPass: null,
        pgbackrestRetentionFullType: null,
        pgbackrestRetentionFull: null,
        pgbackrestRetentionDiff: null,
        pgbackrestRetentionArchiveType: null,
        pgbackrestRetentionArchive: null,
        pgbackrestRetentionHistory: null,
        pgbackrestArchiveAsync: null,
        pgbackrestSpoolPath: null,
      },
      imageUrl: "postgres:17",
      envVars: {
        POSTGRES_PASSWORD: "super-secret",
        PGBACKREST_REPO1_S3_BUCKET: "nouva-backups",
      },
      containerArgs: [],
      dataPath: "/var/lib/postgresql/pgdata",
    };

    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });

  test("round-trips app build settings in deploy payloads", () => {
    const payload = {
      repoUrl: "https://example.com/repo.git",
      commitHash: "abc123",
      commitMessage: "feat: deploy",
      branch: "main",
      subdomain: "frontend",
      serviceName: "frontend",
      projectId: "proj_1",
      serviceId: "svc_1",
      deploymentId: "dep_1",
      envVars: {
        NODE_ENV: "production",
      },
      appBuildType: "static" as const,
      appBuildConfig: {
        buildRoot: "apps/web",
        publishDirectory: "dist",
        spaFallback: true,
      },
      resourceLimits: null,
      runtimeMetadata: null,
    };

    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });

  test("round-trips database provision payloads with explicit resource limits", () => {
    const payload = {
      projectId: "proj_1",
      serviceId: "svc_1",
      serviceName: "main-db",
      variant: "postgres" as const,
      volumeId: "vol_1",
      volumeName: "nouva-vol-vol_1",
      mountPath: "/var/lib/postgresql",
      imageUrl: "postgres:17",
      envVars: {
        POSTGRES_PASSWORD: "super-secret",
      },
      containerArgs: [],
      dataPath: "/var/lib/postgresql/pgdata",
      internalPort: 5432,
      storageSizeGb: 20,
      externalHost: null,
      externalPort: null,
      publicAccessEnabled: false,
      resourceLimits: {
        cpuMillicores: 1500,
      },
      runtimeMetadata: null,
    };

    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });

  test("round-trips mongodb database provision payloads", () => {
    const payload = {
      projectId: "proj_1",
      serviceId: "svc_1",
      serviceName: "main-mongo",
      variant: "mongodb" as const,
      volumeId: "vol_1",
      volumeName: "nouva-vol-vol_1",
      mountPath: "/data/db",
      imageUrl: "mongo:8.0",
      envVars: {
        MONGO_INITDB_ROOT_PASSWORD: "super-secret",
      },
      containerArgs: ["--bind_ip_all"],
      dataPath: "/data/db",
      internalPort: 27017,
      storageSizeGb: 20,
      externalHost: null,
      externalPort: null,
      publicAccessEnabled: false,
      resourceLimits: {
        cpuMillicores: 1500,
      },
      runtimeMetadata: null,
    };

    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });

  test("treats queued and expired work items as leaseable", () => {
    expect(
      canLeaseWorkItem({
        status: "queued",
        leaseExpiresAt: null,
      })
    ).toBe(true);

    expect(
      canLeaseWorkItem({
        status: "leased",
        leaseExpiresAt: new Date(Date.now() - 1_000),
      })
    ).toBe(true);

    expect(
      canLeaseWorkItem({
        status: "leased",
        leaseExpiresAt: new Date(Date.now() + 1_000),
      })
    ).toBe(false);
  });

  test("renders local traefik route config", () => {
    const config = buildTraefikRouteConfig({
      fileKey: "svc-1",
      hostnames: ["app.example.com"],
      serviceUrl: "http://127.0.0.1:3000",
    });

    expect(config).toContain("Host(`app.example.com`)");
    expect(config).toContain("- websecure");
    expect(config).toContain("certResolver: letsencrypt");
    expect(config).toContain("http://127.0.0.1:3000");
  });

  test("round-trips sync routing payloads with provided and custom hostnames", () => {
    const payload = {
      projectId: "proj_1",
      serviceId: "svc_1",
      serviceName: "frontend",
      providedHostname: "frontend.up.nouva.cloud",
      customHostnames: ["app.example.com", "www.example.com"],
      ingressPort: 3000,
      runtimeMetadata: {
        containerName: "nouva-app-svc_1-dep_1",
      },
    };

    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });

  test("parses docker stats snapshots", () => {
    const stats = {
      cpu_stats: {
        cpu_usage: {
          total_usage: 200,
          percpu_usage: [100, 100],
        },
        system_cpu_usage: 10_000,
        online_cpus: 2,
      },
      precpu_stats: {
        cpu_usage: {
          total_usage: 100,
        },
        system_cpu_usage: 5_000,
      },
      memory_stats: {
        usage: 128,
        limit: 512,
      },
      networks: {
        eth0: {
          rx_bytes: 10,
          tx_bytes: 20,
        },
      },
      blkio_stats: {
        io_service_bytes_recursive: [
          { op: "Read", value: 30 },
          { op: "Write", value: 40 },
        ],
      },
      pids_stats: {
        current: 3,
      },
    };

    const parsed = parseDockerStatsSnapshot(stats);

    expect(parsed.cpuUsageBasisPoints).toBe(400);
    expect(parsed.memoryUsageBytes).toBe(128);
    expect(parsed.networkRxBytes).toBe(10);
    expect(parsed.blockWriteBytes).toBe(40);
    expect(negotiateDockerApiVersion({ ApiVersion: "1.47" })).toBe("v1.47");
  });

  test("reads runtime config from env overrides and falls back on invalid registry port", () => {
    process.env.NOUVA_AGENT_HEARTBEAT_INTERVAL_SECONDS = "45";
    process.env.NOUVA_AGENT_POLL_INTERVAL_SECONDS = "12";
    process.env.NOUVA_AGENT_LEASE_TTL_SECONDS = "240";
    process.env.NOUVA_AGENT_METRICS_INTERVAL_SECONDS = "90";
    process.env.NOUVA_AGENT_POSTGRES_OBSERVABILITY_INTERVAL_SECONDS = "75";
    process.env.NOUVA_AGENT_LOCAL_REGISTRY_HOST = "registry.internal";
    process.env.NOUVA_AGENT_LOCAL_REGISTRY_PORT = "not-a-number";
    process.env.NOUVA_AGENT_INGRESS_NETWORK = "nouva-public";

    const config = getAgentRuntimeConfig();

    expect(config.heartbeatIntervalSeconds).toBe(45);
    expect(config.pollIntervalSeconds).toBe(12);
    expect(config.leaseTtlSeconds).toBe(240);
    expect(config.metricsIntervalSeconds).toBe(90);
    expect(config.postgresObservabilityIntervalSeconds).toBe(75);
    expect(config.localRegistryHost).toBe("registry.internal");
    expect(config.localRegistryPort).toBe(5000);
    expect(config.localTraefikNetwork).toBe("nouva-public");
    expect(config.capabilities).toEqual(
      expect.objectContaining({
        dockerApi: true,
        buildkit: true,
        localRegistry: true,
        postgresObservability: true,
      })
    );
  });

  test("parses host metrics snapshots with cpu, memory, disk, and load data", () => {
    const snapshot = {
      currentCpuStat: "cpu  150 0 150 900 0 0 0 0 0 0\ncpu0 75 0 75 450 0 0 0 0 0 0",
      previousCpuStat: "cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0 0 0",
      meminfo: "MemTotal: 2048 kB\nMemAvailable: 512 kB\n",
      loadavg: "0.12 1.50 10.01 1/123 456",
      diskAvailableBytes: 250,
      diskTotalBytes: 1000,
    };

    const parsed = parseHostMetricsSnapshot(snapshot);

    expect(parsed.cpuUsageBasisPoints).toBe(5000);
    expect(parsed.memoryTotalBytes).toBe(2_097_152);
    expect(parsed.memoryUsedBytes).toBe(1_572_864);
    expect(parsed.diskAvailableBytes).toBe(250);
    expect(parsed.diskUsedBytes).toBe(750);
    expect(parsed.loadAvg1mMilli).toBe(120);
    expect(parsed.loadAvg5mMilli).toBe(1500);
    expect(parsed.loadAvg15mMilli).toBe(10010);
    expect(parsed.raw).toBeNull();
    expect(Number.isNaN(Date.parse(parsed.collectedAt))).toBe(false);
  });
});
