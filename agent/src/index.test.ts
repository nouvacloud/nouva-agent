import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import net from "node:net";
import { collectAgentWorkPayloadOperationalValues } from "@repo/runtime/logging";
import agentPackageJson from "../package.json" with { type: "json" };
import type { DeployAppImageInput } from "./app-build-runtime.js";
import { buildAndDeployAppWithDependencies } from "./app-build-runtime.js";
import { DockerApiError } from "./docker-api.js";
import {
  ApiRequestError,
  adoptReregisteredCredentials,
  buildAgentWorkFailureReport,
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
  preflightDatabasePublicPort,
  prepareAppBuildkitRuntime,
  resolveAgentTaskImage,
  resolveAgentWorkLeaseRenewalIntervalMs,
  resolveReportedAgentVersion,
  resolveServiceContainerIdentifier,
  type StoredCredentials,
  sanitizeAgentWorkResult,
  shouldStopRetryingAgentWorkMutation,
  startAgentWorkLeaseRenewal,
} from "./index.js";
import {
  type AgentRuntimeConfig,
  type AppDeployPayload,
  type AppRolloutConfig,
  type CreateVolumeBackupPayload,
  type DatabaseProvisionPayload,
  type RestoreVolumeBackupPayload,
  resolveAppRolloutConfig,
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
    postgresObservability: true,
    cleanupProofV1: true,
  },
  localRegistryHost: "127.0.0.1",
  localRegistryPort: 5000,
  localTraefikNetwork: "nouva-local",
  observability: {
    enabled: false,
    organizationId: null,
    alloyImage: "grafana/alloy:v1.17.1",
    scrapeIntervalSeconds: 30,
    collectorScope: "services_traefik_and_workers",
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
  redactionContextVersion: "hmac-sha256:redaction-context:v1:deployment",
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
  redactionContextVersion: "hmac-sha256:redaction-context:v1:database",
  serviceName: "main-db",
  variant: "postgres",
  environmentId: "env_1",
  volumeId: "vol_1",
  volumeName: "nouva-vol-vol_1",
  mountPath: "/var/lib/postgresql",
  imageUrl: "postgres:17",
  // Mirrors the executor config the control plane hydrates: PGDATA equals `dataPath`, and the
  // socket, SSL and pgpass paths derive from `mountPath`.
  envVars: {
    POSTGRES_USER: "nouva_user",
    POSTGRES_PASSWORD: "super-secret",
    POSTGRES_DB: "nouva_user",
    PGDATA: "/var/lib/postgresql/pgdata",
    POSTGRES_SOCKET_DIR: "/var/lib/postgresql/.sockets",
    POSTGRES_SSL_DIR: "/var/lib/postgresql/ssl",
    POSTGRES_SSL_CERT_FILE: "/var/lib/postgresql/ssl/server.crt",
    POSTGRES_SSL_KEY_FILE: "/var/lib/postgresql/ssl/server.key",
    PGPASSFILE: "/var/lib/postgresql/.pgpass",
    PGBACKREST_STANZA: "vol-vol_1",
    PGBACKREST_REPO1_PATH: "/postgres/v1/projects/proj_1/volumes/vol_1",
  },
  containerArgs: [],
  dataPath: "/var/lib/postgresql/pgdata",
  expectedObjectKey: "pgbackrest/proj_1/vol_1",
  artifactFormat: "pgbackrest-v1",
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
  runtimeMetadata: { containerName: "nouva-redis-svc_redis_1" },
  credentials: { password: "redis-secret" },
  expectedObjectKey:
    "archives/v1/projects/proj_1/volumes/vol_redis_1/backups/backup_redis_1.tar.gz",
  artifactFormat: "redis-rdb-tar-v1",
};

const mongodbBackupPayload: CreateVolumeBackupPayload = {
  ...snapshotBackupPayload,
  serviceId: "svc_mongo_1",
  serviceName: "main-mongo",
  variant: "mongodb",
  version: "8.0",
  volumeId: "vol_mongo_1",
  volumeName: "nouva-vol-vol_mongo_1",
  mountPath: "/data/db",
  backupId: "backup_mongo_1",
  runtimeMetadata: { containerId: "mongo-container-id" },
  credentials: {
    username: "root",
    password: "mongo-secret",
    database: "appdb",
  },
  expectedObjectKey:
    "archives/v1/projects/proj_1/volumes/vol_mongo_1/backups/backup_mongo_1.tar.gz",
  artifactFormat: "mongodb-archive-tar-v1",
};

const mysqlBackupPayload: CreateVolumeBackupPayload = {
  ...snapshotBackupPayload,
  serviceId: "svc_mysql_1",
  serviceName: "main-mysql",
  variant: "mysql",
  version: "8.4",
  volumeId: "vol_mysql_1",
  volumeName: "nouva-vol-vol_mysql_1",
  mountPath: "/var/lib/mysql",
  backupId: "backup_mysql_1",
  runtimeMetadata: { containerId: "mysql-container-id" },
  credentials: {
    username: "app_user",
    password: "mysql-secret",
    database: "appdb",
  },
  imageUrl: "mysql:8.4",
  envVars: {
    MYSQL_ROOT_PASSWORD: "mysql-secret",
    MYSQL_USER: "app_user",
    MYSQL_PASSWORD: "mysql-secret",
    MYSQL_DATABASE: "appdb",
  },
  containerArgs: [],
  dataPath: "/var/lib/mysql",
  expectedObjectKey:
    "archives/v1/projects/proj_1/volumes/vol_mysql_1/backups/backup_mysql_1.tar.gz",
  artifactFormat: "mysql-dump-tar-v1",
};

const mysqlRestorePayload: RestoreVolumeBackupPayload = {
  projectId: "proj_1",
  serviceId: "svc_mysql_1",
  serviceName: "main-mysql",
  variant: "mysql",
  version: "8.4",
  sourceVolumeId: "vol_mysql_1",
  sourceVolumeName: "nouva-vol-vol_mysql_1",
  sourceMountPath: "/var/lib/mysql",
  targetVolumeId: "vol_restored_mysql",
  targetVolumeName: "nouva-vol-vol_restored_mysql",
  targetMountPath: "/var/lib/mysql",
  backupId: "backup_mysql_1",
  engine: "snapshot",
  backupCompletedAt: "2026-03-25T00:00:00Z",
  pgbackrestSet: null,
  artifactSha256: "c".repeat(64),
  destination: {} as never,
  imageUrl: "mysql:8.4",
  envVars: {
    MYSQL_ROOT_PASSWORD: "mysql-secret",
    MYSQL_USER: "app_user",
    MYSQL_PASSWORD: "mysql-secret",
    MYSQL_DATABASE: "appdb",
  },
  containerArgs: [],
  dataPath: "/var/lib/mysql",
  expectedObjectKey:
    "archives/v1/projects/proj_1/volumes/vol_mysql_1/backups/backup_mysql_1.tar.gz",
  artifactFormat: "mysql-dump-tar-v1",
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
  expectedObjectKey: "pgbackrest/proj_1/vol_1",
  artifactFormat: "pgbackrest-v1",
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
    listContainersUsingVolume: mock(async () => []),
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
    drain: {
      durationMs: 0,
      gracefulStopTimeoutSeconds: 10,
      cleanupTimeoutMs: 15_000,
      ...overrides?.drain,
    },
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

describe("adoptReregisteredCredentials", () => {
  test("updates the shared credentials object in place so every caller sees the new token", () => {
    const credentials: StoredCredentials = { serverId: "srv_1", agentToken: "stale-token" };
    // Mirrors main(): the heartbeat loop, work scheduler, and metrics collector all close over the
    // same object rather than re-reading credentials.json.
    const leaseToken = () => credentials.agentToken;

    const result = adoptReregisteredCredentials(credentials, {
      serverId: "srv_1",
      agentToken: "fresh-token",
    });

    expect(result).toBe(credentials);
    expect(credentials).toEqual({ serverId: "srv_1", agentToken: "fresh-token" });
    expect(leaseToken()).toBe("fresh-token");
  });

  test("does not keep a reference to the registration payload", () => {
    const credentials: StoredCredentials = { serverId: "srv_1", agentToken: "stale-token" };
    const payload: StoredCredentials = { serverId: "srv_1", agentToken: "fresh-token" };

    adoptReregisteredCredentials(credentials, payload);
    payload.agentToken = "mutated-after-adoption";

    expect(credentials.agentToken).toBe("fresh-token");
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
  test("sanitizes nested failure reports with the leased environment map", () => {
    const report = buildAgentWorkFailureReport({
      environmentVariables: {
        Q: "x",
        UV: "yz",
      },
      errorMessage: "Command failed: buildctl --opt build-arg:Q=x --opt build-arg:UV=yz",
      result: {
        Q: "x",
        preservedRuntime: {
          statusMessage: "UV=yz",
        },
      },
    });
    const serialized = JSON.stringify(report);

    for (const secret of ["Q", "x", "UV", "yz"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain("[REDACTED]");
    expect(report.result).toBeDefined();
  });

  test("sanitizes successful completion results with the leased environment map", () => {
    const result = sanitizeAgentWorkResult(
      {
        status: "completed",
        Q: "x",
        nested: {
          UV: "yz",
          summary: "Q=x UV=yz",
        },
      },
      {
        Q: "x",
        UV: "yz",
      }
    );
    const serialized = JSON.stringify(result);

    for (const secret of ["Q", "x", "UV", "yz"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(result).toMatchObject({ status: "completed" });
    expect(serialized).toContain("[REDACTED]");
  });

  test("preserves runtime metadata and job protocol keys that collide with environment names", () => {
    const result = sanitizeAgentWorkResult(
      {
        runtimeMetadata: {
          containerId: "ctr_runtime-secret",
        },
        job: {
          status: "failed",
          statusMessage: "job=job-secret",
        },
      },
      {
        runtimeMetadata: "unrelated-runtime-secret",
        job: "job-secret",
      }
    );

    expect(result).toEqual({
      runtimeMetadata: {
        containerId: "ctr_runtime-secret",
      },
      job: {
        status: "failed",
        statusMessage: "[REDACTED]=[REDACTED]",
      },
    });
  });

  test("rejects operational identifiers that contain protected environment material", () => {
    const secret = "sentinel-private-value";

    expect(() =>
      sanitizeAgentWorkResult(
        {
          containerName: `nouva-${secret}`,
          imageUrl: secret,
          objectKey: secret,
          runtimeMetadata: { image: secret },
        },
        { SENTINEL_PRIVATE_NAME: secret }
      )
    ).toThrow("Agent work result conflicts with protected environment material");
  });

  test("drops an ambiguous failure result instead of leaking or corrupting identifiers", () => {
    const secret = "sentinel-private-value";

    expect(
      buildAgentWorkFailureReport({
        environmentVariables: { SENTINEL_PRIVATE_NAME: secret },
        errorMessage: `rollout failed for ${secret}`,
        result: { runtimeMetadata: { containerId: `nouva-${secret}` } },
      })
    ).toEqual({
      errorMessage: "rollout failed for [REDACTED]",
      result: null,
    });
  });

  test("keeps a postgres provision result whose data path equals the leased PGDATA", () => {
    // Regression for #118: PGDATA is byte-identical to the reported runtimeMetadata.dataPath.
    // Uses production-shaped ids: the volume name is `nouva-vol-` plus the first 12 characters of
    // the 24-character volume id, while the pgBackRest stanza carries the full id, so the stanza
    // value is not a substring of the volume name. The shared fixture's short `vol_1` id would
    // make them collide, which real ids never do.
    const volumeId = "q3v8k1zpd0m7wcx5tn2ryhb4";
    const payload: DatabaseProvisionPayload = {
      ...databasePayload,
      volumeId,
      volumeName: `nouva-vol-${volumeId.slice(0, 12)}`,
      envVars: {
        ...databasePayload.envVars,
        PGBACKREST_STANZA: `vol-${volumeId}`,
        PGBACKREST_REPO1_PATH: `/postgres/v1/projects/proj_1/volumes/${volumeId}`,
      },
    };
    const provisionResult = {
      internalHost: "nouva-postgres-svc_1",
      internalPort: 5432,
      externalHost: null,
      externalPort: null,
      runtimeMetadata: {
        containerId: "ctr_pg",
        containerName: "nouva-postgres-svc_1",
        image: "postgres:17",
        publishedPort: null,
        volumeName: payload.volumeName,
        mountPath: "/var/lib/postgresql",
        dataPath: "/var/lib/postgresql/pgdata",
      },
      runtimeInstance: {
        kind: "database",
        status: "running",
        name: "nouva-postgres-svc_1",
        image: "postgres:17",
        containerId: "ctr_pg",
        containerName: "nouva-postgres-svc_1",
        networkName: "nouva-project-proj_1",
        internalHost: "nouva-postgres-svc_1",
        internalPort: 5432,
        externalHost: null,
        externalPort: null,
      },
      statusMessage: "initdb in /var/lib/postgresql/pgdata for POSTGRES_PASSWORD=super-secret",
    };

    const result = sanitizeAgentWorkResult(
      provisionResult,
      payload.envVars ?? {},
      collectAgentWorkPayloadOperationalValues(payload)
    );

    expect(result).toMatchObject({
      runtimeMetadata: provisionResult.runtimeMetadata,
      runtimeInstance: provisionResult.runtimeInstance,
      statusMessage: "initdb in /var/lib/postgresql/pgdata for [REDACTED]=[REDACTED]",
    });
    expect(JSON.stringify(result)).not.toContain("super-secret");
  });

  test("still rejects a data path that only matches an environment value, not the payload", () => {
    const foreignPayload = { ...databasePayload, dataPath: "/var/lib/postgresql/other" };

    expect(() =>
      sanitizeAgentWorkResult(
        { runtimeMetadata: { dataPath: "/var/lib/postgresql/pgdata" } },
        foreignPayload.envVars ?? {},
        collectAgentWorkPayloadOperationalValues(foreignPayload)
      )
    ).toThrow("Agent work result conflicts with protected environment material");
  });

  test("keeps payload paths in failure reports", () => {
    expect(
      buildAgentWorkFailureReport({
        environmentVariables: databasePayload.envVars ?? {},
        errorMessage: "initdb failed in /var/lib/postgresql/pgdata: password super-secret rejected",
        operationalValues: collectAgentWorkPayloadOperationalValues(databasePayload),
        result: { runtimeMetadata: { dataPath: "/var/lib/postgresql/pgdata" } },
      })
    ).toEqual({
      errorMessage: "initdb failed in /var/lib/postgresql/pgdata: password [REDACTED] rejected",
      result: { runtimeMetadata: { dataPath: "/var/lib/postgresql/pgdata" } },
    });
  });

  test("preserves backup and timestamp protocol keys that collide with environment names", () => {
    const result = sanitizeAgentWorkResult(
      {
        activePgbackrestSets: ["20260825-120000F"],
        artifactFormat: "pgbackrest-v1",
        artifactSha256: "sha256-safe-artifact",
        completedAt: "2026-08-25T12:01:00.000Z",
        objectKey: "backups/service-1/backup-1",
        pgbackrestSet: "20260825-120000F",
        pgbackrestType: "full",
        sizeBytes: 4096,
        startedAt: "2026-08-25T12:00:00.000Z",
        verifiedAt: "2026-08-25T12:02:00.000Z",
      },
      {
        activePgbackrestSets: "sets-env-secret",
        artifactFormat: "format-env-secret",
        artifactSha256: "sha-env-secret",
        completedAt: "completed-env-secret",
        objectKey: "object-env-secret",
        pgbackrestSet: "set-env-secret",
        pgbackrestType: "type-env-secret",
        sizeBytes: "size-env-secret",
        startedAt: "started-env-secret",
        verifiedAt: "verified-env-secret",
      }
    );

    expect(result).toEqual({
      activePgbackrestSets: ["20260825-120000F"],
      artifactFormat: "pgbackrest-v1",
      artifactSha256: "sha256-safe-artifact",
      completedAt: "2026-08-25T12:01:00.000Z",
      objectKey: "backups/service-1/backup-1",
      pgbackrestSet: "20260825-120000F",
      pgbackrestType: "full",
      sizeBytes: 4096,
      startedAt: "2026-08-25T12:00:00.000Z",
      verifiedAt: "2026-08-25T12:02:00.000Z",
    });
    expect(result).not.toHaveProperty("[REDACTED]");
  });

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
          NanoCpus: expect.any(Number),
          Memory: expect.any(Number),
          MemorySwap: expect.any(Number),
          PidsLimit: 512,
        }),
      }),
      true
    );
    expect(waitUntilReady).toHaveBeenCalledWith("tcp://127.0.0.1:4567");

    await runtime.cleanup();

    expect(docker.removeContainer).toHaveBeenCalledWith("nouva-buildkitd-dep_1", true);
  });

  test("creates a scoped BuildKit worker when legacy payload limits are null", async () => {
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
        allocatePort: async () => 4568,
        waitUntilReady: async () => {},
      }
    );

    expect(runtime.address).toBe("tcp://127.0.0.1:4568");
    expect(docker.ensureContainer).toHaveBeenCalled();

    await runtime.cleanup();

    expect(docker.removeContainer).toHaveBeenCalledWith("nouva-buildkitd-dep_1", true);
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

  test("applies protected app defaults when legacy resource limits are null", () => {
    const spec = buildAppContainerSpec(runtimeConfig, {
      ...appRuntimePayload,
      resourceLimits: null,
    });

    expect(spec.spec.hostConfig).toEqual(
      expect.objectContaining({
        NanoCpus: 250_000_000,
        Memory: 512 * 1024 * 1024,
        MemorySwap: 512 * 1024 * 1024,
        PidsLimit: 256,
      })
    );
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
        "nouva.redaction.context.version": "hmac-sha256:redaction-context:v1:deployment",
      })
    );
  });
});

describe("deployAppImageWithDependencies", () => {
  test("uses the backward-compatible thirty-second drain defaults", () => {
    expect(resolveAppRolloutConfig(null).drain).toEqual({
      durationMs: 30_000,
      gracefulStopTimeoutSeconds: 10,
      cleanupTimeoutMs: 15_000,
    });
  });

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
    const drainSleep = mock(async () => undefined);
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
        sleep: drainSleep,
      },
      docker as never,
      runtimeConfig,
      {
        ...appRuntimePayload,
        volume: null,
        rollout: createRolloutConfig({
          drain: {
            durationMs: 30_000,
            gracefulStopTimeoutSeconds: 10,
            cleanupTimeoutMs: 15_000,
          },
        }),
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
    expect(drainSleep).toHaveBeenCalledWith(30_000);
    expect(fetchImpl.mock.invocationCallOrder[0]).toBeLessThan(
      drainSleep.mock.invocationCallOrder[0]!
    );
    expect(drainSleep.mock.invocationCallOrder[0]).toBeLessThan(
      docker.stopContainer.mock.invocationCallOrder[0]!
    );
    expect(docker.stopContainer).toHaveBeenCalledWith("nouva-app-svc_1-live", 10, 15_000);
    expect(docker.removeContainer.mock.calls).toEqual([["nouva-app-svc_1-live", false, 15_000]]);
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
        drainDurationMs: 30_000,
        previousContainerRetirement: "graceful",
      })
    );
  });

  test("waits for Docker health instead of accepting TCP while health is starting", async () => {
    const docker = createDockerMock();
    let inspectionCount = 0;
    docker.ensureContainer.mockImplementation(async () => "ctr_candidate");
    docker.inspectContainer.mockImplementation(async (name: string) => {
      if (name !== "nouva-app-svc_1-dep_1") {
        return null;
      }

      inspectionCount += 1;
      return {
        Id: "ctr_candidate",
        Name: name,
        State: {
          Running: true,
          Status: "running",
          Health: { Status: inspectionCount === 1 ? "starting" : "healthy" },
        },
        NetworkSettings: {
          Networks: { "nouva-local": { IPAddress: "172.19.0.10" } },
        },
      };
    });

    const checkTcpConnect = mock(async () => true);
    const drainSleep = mock(async () => undefined);
    const result = await deployAppImageWithDependencies(
      {
        ensureBaseRuntime: async () => undefined,
        checkTcpConnect,
        fetchImpl: mock(async () =>
          Response.json([
            {
              name: "svc-svc_1@file",
              loadBalancer: {
                servers: [{ url: "http://nouva-app-svc_1-dep_1:8080" }],
              },
            },
          ])
        ) as typeof fetch,
        writeLocalTraefikRoute: mock(async () => {}),
        deleteLocalTraefikRoute: mock(async () => {}),
        sleep: drainSleep,
      },
      docker as never,
      runtimeConfig,
      {
        ...appRuntimePayload,
        volume: null,
        rollout: createRolloutConfig(),
        runtimeMetadata: null,
      }
    );

    expect(inspectionCount).toBe(2);
    expect(checkTcpConnect).not.toHaveBeenCalled();
    expect(drainSleep).not.toHaveBeenCalled();
    expect(docker.stopContainer).not.toHaveBeenCalled();
    expect(result.rollout).toEqual(
      expect.objectContaining({
        drainDurationMs: 0,
        previousContainerRetirement: null,
      })
    );
  });

  test("fails immediately when Docker reports an unhealthy candidate", async () => {
    const docker = createDockerMock();
    docker.ensureContainer.mockImplementation(async () => "ctr_candidate");
    docker.inspectContainer.mockImplementation(async (name: string) =>
      name === "nouva-app-svc_1-dep_1"
        ? {
            Id: "ctr_candidate",
            Name: name,
            State: {
              Running: true,
              Status: "running",
              Health: { Status: "unhealthy" },
            },
          }
        : null
    );
    const checkTcpConnect = mock(async () => true);

    await expect(
      deployAppImageWithDependencies(
        {
          ensureBaseRuntime: async () => undefined,
          checkTcpConnect,
          fetchImpl: mock(async () => Response.json([])) as typeof fetch,
          writeLocalTraefikRoute: mock(async () => {}),
          deleteLocalTraefikRoute: mock(async () => {}),
        },
        docker as never,
        runtimeConfig,
        {
          ...appRuntimePayload,
          volume: null,
          rollout: createRolloutConfig(),
          runtimeMetadata: null,
        }
      )
    ).rejects.toHaveProperty(
      "message",
      "Candidate container nouva-app-svc_1-dep_1 became unhealthy"
    );

    expect(checkTcpConnect).not.toHaveBeenCalled();
    expect(docker.removeContainer).toHaveBeenCalledWith("nouva-app-svc_1-dep_1", true);
  });

  test("reports the last Docker health status when readiness times out", async () => {
    const docker = createDockerMock();
    docker.ensureContainer.mockImplementation(async () => "ctr_candidate");
    docker.inspectContainer.mockImplementation(async (name: string) =>
      name === "nouva-app-svc_1-dep_1"
        ? {
            Id: "ctr_candidate",
            Name: name,
            State: {
              Running: true,
              Status: "running",
              Health: { Status: "starting" },
            },
          }
        : null
    );
    const checkTcpConnect = mock(async () => true);

    await expect(
      deployAppImageWithDependencies(
        {
          ensureBaseRuntime: async () => undefined,
          checkTcpConnect,
          fetchImpl: mock(async () => Response.json([])) as typeof fetch,
          writeLocalTraefikRoute: mock(async () => {}),
          deleteLocalTraefikRoute: mock(async () => {}),
        },
        docker as never,
        runtimeConfig,
        {
          ...appRuntimePayload,
          volume: null,
          rollout: createRolloutConfig({
            readiness: {
              timeoutMs: 0,
              intervalMs: 1,
              tcpConnectTimeoutMs: 1,
            },
          }),
          runtimeMetadata: null,
        }
      )
    ).rejects.toHaveProperty(
      "message",
      "Candidate container nouva-app-svc_1-dep_1 health status is starting"
    );

    expect(checkTcpConnect).not.toHaveBeenCalled();
  });

  test("uses a bounded forced removal only when graceful retirement fails", async () => {
    const docker = createDockerMock();
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    docker.ensureContainer.mockImplementation(async () => "ctr_candidate");
    docker.inspectContainer.mockImplementation(async (name: string) =>
      name === "nouva-app-svc_1-dep_1"
        ? {
            Id: "ctr_candidate",
            Name: name,
            State: { Running: true },
            NetworkSettings: {
              Networks: { "nouva-local": { IPAddress: "172.19.0.10" } },
            },
          }
        : null
    );
    docker.stopContainer.mockRejectedValueOnce(new Error("stop failed"));

    try {
      const result = await deployAppImageWithDependencies(
        {
          ensureBaseRuntime: async () => undefined,
          checkTcpConnect: mock(async () => true),
          fetchImpl: mock(async () =>
            Response.json([
              {
                name: "svc-svc_1@file",
                loadBalancer: {
                  servers: [{ url: "http://nouva-app-svc_1-dep_1:8080" }],
                },
              },
            ])
          ) as typeof fetch,
          writeLocalTraefikRoute: mock(async () => {}),
          deleteLocalTraefikRoute: mock(async () => {}),
          sleep: mock(async () => undefined),
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

      expect(docker.stopContainer).toHaveBeenCalledWith("nouva-app-svc_1-live", 10, 15_000);
      expect(docker.removeContainer.mock.calls).toEqual([["nouva-app-svc_1-live", true, 15_000]]);
      expect(warn).toHaveBeenCalledWith(
        "[nouva-agent] app rollout retirement fallback",
        expect.objectContaining({
          containerName: "nouva-app-svc_1-live",
          deploymentId: "dep_1",
          serviceId: "svc_1",
        })
      );
      expect(result.rollout).toEqual(
        expect.objectContaining({ previousContainerRetirement: "forced" })
      );
    } finally {
      warn.mockRestore();
    }
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
    expect(docker.stopContainer).not.toHaveBeenCalled();
  });

  test("stops and snapshots a volume app before launching its candidate", async () => {
    const docker = createDockerMock();
    docker.listContainersUsingVolume
      .mockImplementationOnce(async () => [
        {
          Id: "ctr_live",
          Name: "/nouva-app-svc_1-live",
          State: { Running: true },
        },
      ])
      .mockImplementation(async () => []);
    docker.ensureContainer.mockImplementation(async () => "ctr_candidate");
    docker.inspectContainer.mockImplementation(async (name: string) => {
      if (name === "nouva-app-svc_1-dep_1") {
        return {
          Id: "ctr_candidate",
          Name: name,
          State: { Running: true },
          NetworkSettings: {
            Networks: { "nouva-local": { IPAddress: "172.19.0.10" } },
          },
        };
      }
      return null;
    });

    let serviceUrl = "http://nouva-app-svc_1-live:8080";
    const result = await deployAppImageWithDependencies(
      {
        ensureBaseRuntime: async () => undefined,
        checkTcpConnect: mock(async () => true),
        fetchImpl: mock(async () =>
          Response.json([
            {
              name: "svc-svc_1@file",
              loadBalancer: { servers: [{ url: serviceUrl }] },
            },
          ])
        ) as typeof fetch,
        writeLocalTraefikRoute: mock(
          async (_paths: unknown, _serviceId: string, _hostnames: unknown, nextUrl: string) => {
            serviceUrl = nextUrl;
          }
        ),
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
    );

    expect(docker.stopContainer).toHaveBeenCalledWith("nouva-app-svc_1-live");
    expect(docker.stopContainer.mock.invocationCallOrder[0]).toBeLessThan(
      docker.ensureContainer.mock.invocationCallOrder[0]!
    );
    expect(result.rollout).toEqual(
      expect.objectContaining({
        strategy: "single_writer_snapshot_cutover",
        outcome: "committed",
      })
    );
  });

  test("restarts the previous app without launching a candidate when volume snapshot fails", async () => {
    const docker = createDockerMock();
    docker.listContainersUsingVolume.mockImplementationOnce(async () => [
      {
        Id: "ctr_live",
        Name: "/nouva-app-svc_1-live",
        State: { Running: true },
      },
    ]);
    docker.waitContainer.mockImplementationOnce(async () => 1);
    docker.containerLogs.mockImplementationOnce(async () => "Insufficient snapshot capacity");
    docker.inspectContainer.mockImplementation(async (name: string) =>
      name === "nouva-app-svc_1-live"
        ? {
            Id: "ctr_live",
            Name: name,
            State: { Running: true },
            NetworkSettings: {
              Networks: { "nouva-local": { IPAddress: "172.19.0.9" } },
            },
          }
        : null
    );

    await expect(
      deployAppImageWithDependencies(
        {
          ensureBaseRuntime: async () => undefined,
          checkTcpConnect: mock(async () => true),
          fetchImpl: mock(async () =>
            Response.json([
              {
                name: "svc-svc_1@file",
                loadBalancer: {
                  servers: [{ url: "http://nouva-app-svc_1-live:8080" }],
                },
              },
            ])
          ) as typeof fetch,
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
      message: "Insufficient snapshot capacity",
      result: {
        rollout: expect.objectContaining({
          outcome: "aborted_before_cutover",
          liveRuntimePreserved: true,
          strategy: "single_writer_snapshot_cutover",
        }),
      },
    });

    expect(docker.ensureContainer).not.toHaveBeenCalled();
    expect(docker.stopContainer).toHaveBeenCalledWith("nouva-app-svc_1-live");
    expect(docker.startContainer).toHaveBeenCalledWith("nouva-app-svc_1-live");
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

  test("applies protected database defaults when legacy resource limits are null", () => {
    const spec = buildDatabaseContainerSpec({
      ...databasePayload,
      resourceLimits: null,
    });

    expect(spec.spec.hostConfig).toEqual(
      expect.objectContaining({
        NanoCpus: 500_000_000,
        Memory: 1024 * 1024 * 1024,
        MemorySwap: 1024 * 1024 * 1024,
        PidsLimit: 512,
      })
    );
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
        "nouva.redaction.context.version": "hmac-sha256:redaction-context:v1:database",
      })
    );
  });
});

describe("database runtime recreate paths", () => {
  async function withOccupiedHostPort(callback: (port: number) => Promise<void>): Promise<void> {
    const listener = net.createServer();
    await new Promise<void>((resolve) =>
      listener.listen({ host: "0.0.0.0", port: 0 }, () => resolve())
    );
    const address = listener.address();
    if (!address || typeof address === "string") {
      listener.close();
      throw new Error("Failed to allocate test listener");
    }

    try {
      await callback(address.port);
    } finally {
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve()))
      );
    }
  }

  test("rejects an occupied public port before Docker mutations", async () => {
    const docker = createDockerMock();

    await withOccupiedHostPort(async (port) => {
      await expect(
        handleDatabaseProvision(docker as never, runtimeConfig, {
          ...databasePayload,
          publicAccessEnabled: true,
          externalHost: "203.0.113.20",
          externalPort: port,
        })
      ).rejects.toThrow(`Public database port ${port} is already occupied`);
    });

    expect(docker.ensureNetwork).not.toHaveBeenCalled();
    expect(docker.createVolume).not.toHaveBeenCalled();
    expect(docker.ensureContainer).not.toHaveBeenCalled();
  });

  test("checks an occupied public port before removing a database for volume apply", async () => {
    const docker = createDockerMock();

    await withOccupiedHostPort(async (port) => {
      await expect(
        handleApplyDatabaseVolume(docker as never, runtimeConfig, {
          ...databasePayload,
          publicAccessEnabled: true,
          externalHost: "203.0.113.20",
          externalPort: port,
          runtimeMetadata: {
            containerName: "nouva-postgres-prev",
          },
        })
      ).rejects.toThrow(`Public database port ${port} is already occupied`);
    });

    expect(docker.removeContainer).not.toHaveBeenCalled();
    expect(docker.removeVolume).not.toHaveBeenCalled();
  });

  test("checks an occupied public port before removing an attached database volume", async () => {
    const docker = createDockerMock();

    await withOccupiedHostPort(async (port) => {
      await expect(
        handleWipeVolume(docker as never, runtimeConfig, {
          ...databasePayload,
          publicAccessEnabled: true,
          externalHost: "203.0.113.20",
          externalPort: port,
          runtimeMetadata: {
            containerName: "nouva-postgres-prev",
          },
        })
      ).rejects.toThrow(`Public database port ${port} is already occupied`);
    });

    expect(docker.removeContainer).not.toHaveBeenCalled();
    expect(docker.removeVolume).not.toHaveBeenCalled();
  });

  test("allows a running Nouva container for the same service to retain its binding", async () => {
    const docker = createDockerMock();
    docker.inspectContainer.mockResolvedValue({
      Id: "ctr_existing",
      Name: "nouva-postgres-svc_1",
      State: { Running: true },
      Config: {
        Labels: {
          "nouva.managed": "true",
          "nouva.service.id": "svc_1",
        },
      },
      HostConfig: {
        PortBindings: {
          "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "61234" }],
        },
      },
    });

    await expect(
      preflightDatabasePublicPort(docker as never, {
        ...databasePayload,
        publicAccessEnabled: true,
        externalHost: "203.0.113.20",
        externalPort: 61234,
      })
    ).resolves.toBeUndefined();
  });

  test("requires a valid port only when public access is enabled", async () => {
    const docker = createDockerMock();

    await expect(
      preflightDatabasePublicPort(docker as never, databasePayload)
    ).resolves.toBeUndefined();
    await expect(
      preflightDatabasePublicPort(docker as never, {
        ...databasePayload,
        publicAccessEnabled: true,
        externalPort: null,
      })
    ).rejects.toThrow("valid external port between 1 and 65535");
    expect(docker.inspectContainer).not.toHaveBeenCalled();
  });

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
    expect(docker.ensureContainer.mock.calls[0]?.[0]?.hostConfig).toEqual(
      expect.objectContaining({
        NanoCpus: 500_000_000,
        PidsLimit: 512,
      })
    );
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
    docker.containerLogs.mockResolvedValueOnce(
      'NOUVA_PGBACKREST_INFO:[{"backup":[{"label":"20260325-000000F","type":"full","timestamp":{"stop":1774396800},"annotation":{"nouva-backup-id":"backup_1"}}]}]'
    );

    await handleCreateVolumeBackup(docker as never, runtimeConfig, pgBackrestBackupPayload);

    expect(docker.createContainer).toHaveBeenCalledTimes(2);
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

  test("dumps MySQL through a service-image sidecar and verifies the uploaded archive", async () => {
    const docker = createDockerMock();
    docker.containerLogs.mockResolvedValue(
      "NOUVA_SIZE_BYTES:128\nNOUVA_SHA256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    );

    const result = await handleCreateVolumeBackup(
      docker as never,
      runtimeConfig,
      mysqlBackupPayload
    );

    expect(docker.createVolume).toHaveBeenCalledWith(
      "nouva-backup-stage-backup_mysql",
      expect.objectContaining({ "nouva.resource": "backup-stage" })
    );
    const dumpTask = docker.createContainer.mock.calls[0]?.[0];
    const dumpScript = dumpTask?.cmd?.[0];
    expect(dumpTask).toEqual(
      expect.objectContaining({
        image: "mysql:8.4",
        env: ["MYSQL_PWD=mysql-secret"],
        entrypoint: ["sh", "-c"],
        hostConfig: expect.objectContaining({
          NetworkMode: "container:mysql-container-id",
          Mounts: [
            expect.objectContaining({
              Source: "nouva-backup-stage-backup_mysql",
              Target: "/stage",
            }),
          ],
        }),
      })
    );
    expect(dumpScript).toContain("mysqldump -h127.0.0.1 -P3306 -uroot");
    expect(dumpScript).toContain("--single-transaction");
    expect(dumpScript).toContain("--databases");
    expect(dumpScript).not.toContain("mysql-secret");

    const verifyTask = docker.createContainer.mock.calls[1]?.[0];
    const verifyScript = verifyTask?.cmd?.[2];
    expect(verifyTask?.env).toEqual(expect.arrayContaining(["NOUVA_BACKUP_ID=backup_mysql_1"]));
    expect(verifyTask?.env).not.toEqual(expect.arrayContaining(["MYSQL_PWD=mysql-secret"]));
    expect(verifyScript).toContain('grep -q "Dump completed"');
    expect(verifyScript).toContain("rclone copyto");
    expect(verifyTask?.env).toEqual(
      expect.arrayContaining([
        "RCLONE_CONFIG_NOUVAARCHIVE_TYPE=s3",
        "RCLONE_CONFIG_NOUVAARCHIVE_ENDPOINT=https://s3.example.com",
        "RCLONE_CONFIG_NOUVAARCHIVE_SECRET_ACCESS_KEY=secret-key",
        "RCLONE_CONFIG_NOUVAARCHIVE_INSECURE_SKIP_VERIFY=false",
      ])
    );
    expect(verifyScript).toMatch(
      /remote="nouvaarchive:\$\{BACKUP_BUCKET\}\/\$\{BACKUP_OBJECT_KEY\}"/
    );
    expect(verifyScript).not.toContain("secret-key");
    expect(verifyScript).not.toContain("https://s3.example.com");
    expect(docker.removeVolume).toHaveBeenLastCalledWith("nouva-backup-stage-backup_mysql", true);
    expect(result).toEqual(
      expect.objectContaining({
        sizeBytes: 128,
        objectKey: mysqlBackupPayload.expectedObjectKey,
        artifactFormat: "mysql-dump-tar-v1",
        integrityProof: expect.objectContaining({
          engine: "mysql",
          mysqldumpSucceeded: true,
          dumpCompletedMarkerVerified: true,
          uploadChecksumVerified: true,
        }),
      })
    );
  });

  test("removes the MySQL staging volume when the dump sidecar fails", async () => {
    const docker = createDockerMock();
    docker.waitContainer.mockResolvedValueOnce(1);
    docker.containerLogs.mockResolvedValueOnce("mysqldump: Got error: 1045");

    await expect(
      handleCreateVolumeBackup(docker as never, runtimeConfig, mysqlBackupPayload)
    ).rejects.toThrow("mysqldump: Got error: 1045");

    expect(docker.createContainer).toHaveBeenCalledTimes(1);
    expect(docker.removeVolume).toHaveBeenLastCalledWith("nouva-backup-stage-backup_mysql", true);
  });

  test("restores a MySQL dump by replaying it through the service image on a staged volume", async () => {
    const docker = createDockerMock();

    const result = await handleRestoreVolumeBackup(
      docker as never,
      runtimeConfig,
      mysqlRestorePayload
    );

    expect(docker.createVolume).toHaveBeenNthCalledWith(
      1,
      "nouva-vol-vol_restored_mysql",
      expect.objectContaining({ "nouva.volume.id": "vol_restored_mysql" })
    );
    expect(docker.createVolume).toHaveBeenNthCalledWith(
      2,
      "nouva-restore-stage-backup_mysql",
      expect.objectContaining({ "nouva.resource": "restore-stage" })
    );

    const fetchTask = docker.createContainer.mock.calls[0]?.[0];
    expect(fetchTask?.env).toEqual(expect.arrayContaining([`EXPECTED_SHA256=${"c".repeat(64)}`]));
    expect(fetchTask?.cmd?.[2]).toContain('grep -qx "dump.sql.gz"');

    const replayTask = docker.createContainer.mock.calls[1]?.[0];
    expect(replayTask).toEqual(
      expect.objectContaining({
        image: "mysql:8.4",
        entrypoint: ["sh", "-c"],
        hostConfig: expect.objectContaining({
          Mounts: [
            expect.objectContaining({
              Source: "nouva-vol-vol_restored_mysql",
              Target: "/var/lib/mysql",
            }),
            expect.objectContaining({
              Source: "nouva-restore-stage-backup_mysql",
              Target: "/docker-entrypoint-initdb.d",
              ReadOnly: true,
            }),
          ],
        }),
      })
    );
    expect(replayTask?.env).toEqual(
      expect.arrayContaining(["MYSQL_ROOT_PASSWORD=mysql-secret", "MYSQL_DATABASE=appdb"])
    );
    expect(replayTask?.env).not.toEqual(expect.arrayContaining(["MYSQL_PWD=mysql-secret"]));
    expect(replayTask?.cmd?.[0]).toContain("docker-entrypoint.sh mysqld");
    expect(replayTask?.cmd?.[0]).toContain("mysqladmin");
    expect(docker.removeVolume).toHaveBeenLastCalledWith("nouva-restore-stage-backup_mysql", true);
    expect(result).toEqual(
      expect.objectContaining({
        volumeName: "nouva-vol-vol_restored_mysql",
        restoreProof: expect.objectContaining({
          validationMethod: "mysql-startup-sql-read",
          isolatedDatabaseStarted: true,
          targetVolumeId: "vol_restored_mysql",
        }),
      })
    );
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

  test("creates and verifies a MongoDB logical archive through the live container network", async () => {
    const docker = createDockerMock();
    docker.containerLogs.mockResolvedValue(
      "NOUVA_SIZE_BYTES:84\nNOUVA_SHA256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    );

    const result = await handleCreateVolumeBackup(
      docker as never,
      runtimeConfig,
      mongodbBackupPayload
    );

    const task = docker.createContainer.mock.calls[0]?.[0];
    const script = task?.cmd?.[2];
    expect(task).toEqual(
      expect.objectContaining({
        env: expect.arrayContaining([
          "MONGODB_USERNAME=root",
          "MONGODB_PASSWORD=mongo-secret",
          "NOUVA_BACKUP_ID=backup_mongo_1",
        ]),
        hostConfig: expect.objectContaining({
          Mounts: undefined,
          NetworkMode: "container:mongo-container-id",
        }),
      })
    );
    expect(script).toContain("mongodump --host 127.0.0.1 --port 27017");
    expect(script).toContain("--authenticationDatabase admin");
    expect(script).toContain("mongorestore --host 127.0.0.1 --port 27017");
    expect(script).toContain("--dryRun");
    expect(script).not.toContain("mongo-secret");
    expect(result).toEqual(
      expect.objectContaining({
        sizeBytes: 84,
        objectKey: mongodbBackupPayload.expectedObjectKey,
        artifactFormat: "mongodb-archive-tar-v1",
        artifactSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        integrityProof: expect.objectContaining({
          engine: "mongodb",
          mongodumpSucceeded: true,
          mongorestoreDryRun: true,
          uploadChecksumVerified: true,
        }),
      })
    );
  });

  test("uses the installed agent image for snapshot backup tasks", async () => {
    const docker = createDockerMock();
    docker.containerLogs.mockResolvedValue(
      "NOUVA_SIZE_BYTES:42\nNOUVA_SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nNOUVA_REDIS_SOURCE_MODE:rdb"
    );
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
        cmd: ["sh", "-c", expect.stringContaining("redis-cli -h 127.0.0.1 --rdb")],
        hostConfig: expect.objectContaining({
          Mounts: undefined,
          NetworkMode: "container:nouva-redis-svc_redis_1",
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

  test("does not contain the removed custom runtime log collector loop", async () => {
    const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");

    expect(source).not.toContain("/api/agent/logs/runtime");
    expect(source).not.toContain("syncRuntimeLogs");
    expect(source).not.toContain("NOUVA_AGENT_RUNTIME_LOG_SYNC_INTERVAL_MS");
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
