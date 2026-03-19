import { mkdir, readFile, readlink, rename, rm, statfs, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  type AgentCapabilities,
  type AgentHeartbeatResponse,
  type AgentLeaseResponse,
  type AgentMetricsEnvelope,
  type AgentMetricsRequest,
  type AgentRegistrationResponse,
  type AgentRuntimeConfig,
  type AgentWorkRecord,
  type AppDeployPayload,
  buildLocalHttpRouteConfig,
  type DatabaseProvisionPayload,
  type DeployOnlyPayload,
  getAgentRuntimeConfig,
  getDefaultAgentCapabilities,
  parseHostMetricsSnapshot,
  type RuntimeMetadata,
  type ServerValidationReport,
  type SyncRoutingPayload,
  type UpdateAgentPayload,
} from "@nouvacloud/agent-protocol";
import { getImageConfig, type ServiceCredentials } from "@nouvacloud/service-images";
import { buildApp, hashProjectNetwork } from "./build.js";
import { DockerApiClient } from "./docker-api.js";

const API_URL = process.env.NOUVA_API_URL;
const SERVER_ID = process.env.NOUVA_SERVER_ID;
const REGISTRATION_TOKEN = process.env.NOUVA_REGISTRATION_TOKEN;
const DATA_DIR = "/var/lib/nouva-agent";
const CREDENTIALS_PATH = path.join(DATA_DIR, "credentials.json");
const TRAEFIK_DYNAMIC_DIR = path.join(DATA_DIR, "traefik", "dynamic");
const AGENT_VERSION = process.env.NOUVA_AGENT_VERSION || "0.1.0";
const APP_DOMAIN = process.env.NOUVA_APP_DOMAIN || "nouva.cloud";
const DATA_VOLUME = process.env.NOUVA_AGENT_DATA_VOLUME || "nouva-agent-data";
const BUILDKIT_CONTAINER_NAME = process.env.NOUVA_AGENT_BUILDKIT_CONTAINER || "nouva-buildkitd";
const LOCAL_REGISTRY_CONTAINER_NAME =
  process.env.NOUVA_AGENT_REGISTRY_CONTAINER || "nouva-registry";
const TRAEFIK_CONTAINER_NAME = process.env.NOUVA_AGENT_TRAEFIK_CONTAINER || "nouva-traefik";
const BUILDKIT_ADDRESS = process.env.NOUVA_AGENT_BUILDKIT_ADDR || "tcp://127.0.0.1:1234";

if (!API_URL || !SERVER_ID) {
  throw new Error("Missing NOUVA_API_URL or NOUVA_SERVER_ID");
}

interface StoredCredentials {
  serverId: string;
  agentToken: string;
}

interface ValidationSnapshot {
  hostname: string;
  operatingSystem: string | null;
  architecture: string | null;
  dockerVersion: string | null;
  publicIp: string | null;
  cpuCores: number | null;
  memoryBytes: number | null;
  diskBytesAvailable: number | null;
  latestValidationReport: ServerValidationReport;
  capabilities: AgentCapabilities;
}

function toObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function toRecord(value: unknown): Record<string, string> {
  const record = toObject(value);
  const next: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "string") {
      next[key] = entry;
    }
  }
  return next;
}

function toRuntimeMetadata(value: unknown): RuntimeMetadata | null {
  const metadata = toObject(value);
  return Object.keys(metadata).length > 0 ? (metadata as RuntimeMetadata) : null;
}

function toServiceCredentials(value: unknown): ServiceCredentials {
  const credentials = toRecord(value);
  if (!credentials.username || !credentials.password) {
    throw new Error("Database credentials are incomplete");
  }

  return {
    username: credentials.username,
    password: credentials.password,
    ...(credentials.database ? { database: credentials.database } : {}),
  };
}

function toUpdateAgentPayload(value: unknown): UpdateAgentPayload {
  const payload = toObject(value);
  const imageTag = payload.imageTag;

  if (typeof imageTag !== "string" || imageTag.trim().length === 0) {
    throw new Error("Agent update payload is missing imageTag");
  }

  return {
    imageTag,
  };
}

async function readCredentials(): Promise<StoredCredentials | null> {
  try {
    return JSON.parse(await readFile(CREDENTIALS_PATH, "utf8")) as StoredCredentials;
  } catch {
    return null;
  }
}

async function writeCredentials(credentials: StoredCredentials): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${CREDENTIALS_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(credentials, null, 2));
  await rename(tmp, CREDENTIALS_PATH);
}

function buildCheck(
  key: string,
  label: string,
  status: "pass" | "warn" | "fail",
  message: string,
  value: string | null = null
) {
  return { key, label, status, message, value };
}

async function checkPortAvailability(port: number) {
  return await new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "0.0.0.0");
  });
}

async function checkTcpConnect(host: string, port: number, timeoutMs = 3000) {
  return await new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

async function collectValidationSnapshot(docker: DockerApiClient): Promise<ValidationSnapshot> {
  const checks: ValidationSnapshot["latestValidationReport"]["checks"] = [];
  const hostOsId = (process.env.NOUVA_HOST_OS_ID || "unknown").toLowerCase();
  const hostOsVersion = process.env.NOUVA_HOST_OS_VERSION_ID || "unknown";
  const hostArch = os.arch();

  const osSupported = hostOsId === "ubuntu" && hostOsVersion === "24.04";
  checks.push(
    buildCheck(
      "os",
      "Supported OS",
      osSupported ? "pass" : "fail",
      osSupported ? "Ubuntu 24.04 detected" : "Nouva currently supports Ubuntu 24.04 only",
      `${hostOsId} ${hostOsVersion}`
    )
  );

  const archSupported = hostArch === "x64" || hostArch === "amd64";
  checks.push(
    buildCheck(
      "arch",
      "Supported architecture",
      archSupported ? "pass" : "fail",
      archSupported ? "x86_64 detected" : "Nouva currently supports x86_64 only",
      hostArch
    )
  );

  let dockerVersion: string | null = null;
  try {
    const version = await docker.request<{ Version?: string }>("GET", "/version");
    dockerVersion = version.Version ?? null;
    checks.push(
      buildCheck(
        "docker",
        "Docker Engine",
        dockerVersion ? "pass" : "fail",
        dockerVersion ? "Docker Engine is available" : "Docker Engine is unavailable",
        dockerVersion
      )
    );
  } catch (error) {
    checks.push(
      buildCheck(
        "docker",
        "Docker Engine",
        "fail",
        error instanceof Error ? error.message : "Docker Engine is unavailable"
      )
    );
  }

  const port80Available = await checkPortAvailability(80);
  checks.push(
    buildCheck(
      "port-80",
      "Port 80",
      port80Available ? "pass" : "warn",
      port80Available ? "Port 80 is available" : "Port 80 is already in use",
      "80"
    )
  );

  const port443Available = await checkPortAvailability(443);
  checks.push(
    buildCheck(
      "port-443",
      "Port 443",
      port443Available ? "pass" : "warn",
      port443Available ? "Port 443 is available" : "Port 443 is already in use",
      "443"
    )
  );

  let diskBytesAvailable: number | null = null;
  try {
    const stats = await statfs("/hostfs");
    diskBytesAvailable = Number(stats.bavail) * Number(stats.bsize);
    checks.push(
      buildCheck(
        "disk",
        "Disk headroom",
        diskBytesAvailable >= 20 * 1024 * 1024 * 1024 ? "pass" : "warn",
        diskBytesAvailable >= 20 * 1024 * 1024 * 1024
          ? "At least 20GB free"
          : "Less than 20GB free on the server",
        String(diskBytesAvailable)
      )
    );
  } catch (error) {
    checks.push(
      buildCheck(
        "disk",
        "Disk headroom",
        "warn",
        error instanceof Error ? error.message : "Unable to inspect disk"
      )
    );
  }

  try {
    const response = await fetch(`${API_URL}/health`);
    checks.push(
      buildCheck(
        "outbound",
        "Outbound connectivity",
        response.ok ? "pass" : "fail",
        response.ok ? "Can reach Nouva API" : "Cannot reach Nouva API",
        String(response.status)
      )
    );
  } catch (error) {
    checks.push(
      buildCheck(
        "outbound",
        "Outbound connectivity",
        "fail",
        error instanceof Error ? error.message : "Unable to reach Nouva API"
      )
    );
  }

  const totalMemoryBytes = os.totalmem();
  const twoGB = 2 * 1024 * 1024 * 1024;
  const oneGB = 1024 * 1024 * 1024;
  checks.push(
    buildCheck(
      "memory",
      "Memory headroom",
      totalMemoryBytes >= twoGB ? "pass" : totalMemoryBytes >= oneGB ? "warn" : "fail",
      totalMemoryBytes >= twoGB
        ? "At least 2 GB RAM available"
        : totalMemoryBytes >= oneGB
          ? "Less than 2 GB RAM — some workloads may be constrained"
          : "Less than 1 GB RAM — insufficient for most workloads",
      String(totalMemoryBytes)
    )
  );

  const buildkitMatch = BUILDKIT_ADDRESS.match(/^tcp:\/\/([^:]+):(\d+)/);
  if (buildkitMatch) {
    const [, bkHost, bkPort] = buildkitMatch;
    if (bkHost && bkPort) {
      const buildkitReachable = await checkTcpConnect(bkHost, Number(bkPort));
      checks.push(
        buildCheck(
          "buildkit",
          "BuildKit daemon",
          buildkitReachable ? "pass" : "warn",
          buildkitReachable
            ? "BuildKit daemon is reachable"
            : "BuildKit daemon is not yet reachable — image builds will fail until it starts",
          BUILDKIT_ADDRESS
        )
      );
    }
  }

  // IP forwarding — required for all Docker container networking and NAT
  try {
    const ipForward = (await readFile("/hostfs/proc/sys/net/ipv4/ip_forward", "utf8")).trim();
    checks.push(
      buildCheck(
        "ip-forward",
        "IP forwarding",
        ipForward === "1" ? "pass" : "fail",
        ipForward === "1"
          ? "IP forwarding is enabled"
          : "IP forwarding is disabled — container networking and NAT will not work",
        ipForward
      )
    );
  } catch (error) {
    checks.push(
      buildCheck(
        "ip-forward",
        "IP forwarding",
        "warn",
        error instanceof Error ? error.message : "Unable to read IP forwarding state"
      )
    );
  }

  // cgroup v2 — required for correct memory limits and OOM handling on containers
  try {
    await readFile("/hostfs/sys/fs/cgroup/cgroup.controllers", "utf8");
    checks.push(
      buildCheck("cgroup-version", "cgroup v2", "pass", "cgroup v2 unified hierarchy detected")
    );
  } catch {
    checks.push(
      buildCheck(
        "cgroup-version",
        "cgroup v2",
        "fail",
        "cgroup v1 detected — container memory limits and OOM protection will not be enforced correctly"
      )
    );
  }

  // Clock synchronisation — drift breaks TLS, ACME challenges, and pgBackRest PITR
  {
    let clockSynced = false;
    try {
      await readFile("/hostfs/run/chrony/chrony.sock");
      clockSynced = true;
    } catch {}
    if (!clockSynced) {
      try {
        await readFile("/hostfs/run/systemd/timesync/synchronized");
        clockSynced = true;
      } catch {}
    }
    checks.push(
      buildCheck(
        "clock-sync",
        "Clock synchronisation",
        clockSynced ? "pass" : "warn",
        clockSynced
          ? "Time synchronisation daemon is active"
          : "No active NTP/chrony sync detected — clock drift may break TLS certificates and PITR timestamps"
      )
    );
  }

  // DNS configuration — systemd-resolved stub listener causes silent DNS failures in containers
  try {
    let isStub = false;
    try {
      const symlinkTarget = await readlink("/hostfs/etc/resolv.conf");
      isStub = symlinkTarget.includes("stub-resolv.conf");
    } catch {
      const content = await readFile("/hostfs/etc/resolv.conf", "utf8");
      isStub =
        /^nameserver\s+127\.0\.0\.53$/m.test(content) && !content.includes("nameserver 127.0.0.1");
    }
    checks.push(
      buildCheck(
        "dns-stub",
        "DNS configuration",
        isStub ? "warn" : "pass",
        isStub
          ? "resolv.conf points to systemd-resolved stub (127.0.0.53) — container DNS resolution may fail"
          : "DNS configuration looks correct"
      )
    );
  } catch (error) {
    checks.push(
      buildCheck(
        "dns-stub",
        "DNS configuration",
        "warn",
        error instanceof Error ? error.message : "Unable to inspect DNS configuration"
      )
    );
  }

  // inotify watch limit — Traefik file watching silently stops when the host limit is exhausted
  try {
    const maxWatches = parseInt(
      (await readFile("/hostfs/proc/sys/fs/inotify/max_user_watches", "utf8")).trim()
    );
    checks.push(
      buildCheck(
        "inotify-limits",
        "inotify watch limit",
        maxWatches >= 65536 ? "pass" : "warn",
        maxWatches >= 65536
          ? `inotify watch limit is sufficient (${maxWatches.toLocaleString()})`
          : `inotify watch limit is low (${maxWatches.toLocaleString()}) — Traefik file watching may silently stop as more services are deployed`,
        String(maxWatches)
      )
    );
  } catch (error) {
    checks.push(
      buildCheck(
        "inotify-limits",
        "inotify watch limit",
        "warn",
        error instanceof Error ? error.message : "Unable to read inotify limits"
      )
    );
  }

  let publicIp: string | null = null;
  try {
    const response = await fetch("https://api.ipify.org?format=json");
    if (response.ok) {
      const body = (await response.json()) as { ip?: string };
      publicIp = body.ip ?? null;
    }
  } catch {}

  const summary = checks.reduce(
    (acc, check) => {
      acc[check.status] += 1;
      return acc;
    },
    { pass: 0, warn: 0, fail: 0 }
  );

  return {
    hostname: os.hostname(),
    operatingSystem: `${hostOsId} ${hostOsVersion}`,
    architecture: hostArch,
    dockerVersion,
    publicIp,
    cpuCores: os.cpus().length,
    memoryBytes: os.totalmem(),
    diskBytesAvailable,
    latestValidationReport: {
      checkedAt: new Date().toISOString(),
      summary,
      checks,
    },
    capabilities: getDefaultAgentCapabilities(),
  };
}

async function apiRequest<T>(
  pathName: string,
  options: {
    method?: string;
    body?: unknown;
    token?: string;
  } = {}
): Promise<T> {
  const response = await fetch(`${API_URL}${pathName}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(
      `${options.method ?? "GET"} ${pathName} failed (${response.status}): ${message}`
    );
  }

  return (await response.json()) as T;
}

let registrationUsed = false;

async function registerAgent(docker: DockerApiClient): Promise<{
  credentials: StoredCredentials;
  config: AgentRuntimeConfig;
}> {
  const snapshot = await collectValidationSnapshot(docker);
  const payload = await apiRequest<AgentRegistrationResponse>("/api/agent/register", {
    method: "POST",
    body: {
      serverId: SERVER_ID!,
      registrationToken: REGISTRATION_TOKEN,
      agentVersion: AGENT_VERSION,
      ...snapshot,
    },
  });

  const credentials = {
    serverId: SERVER_ID!,
    agentToken: payload.agentToken,
  };
  await writeCredentials(credentials);
  registrationUsed = true;

  return { credentials, config: payload.config };
}

async function sendHeartbeat(
  docker: DockerApiClient,
  credentials: StoredCredentials
): Promise<AgentRuntimeConfig> {
  const snapshot = await collectValidationSnapshot(docker);

  const response = await fetch(`${API_URL}/api/agent/heartbeat`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credentials.agentToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      serverId: SERVER_ID!,
      agentVersion: AGENT_VERSION,
      ...snapshot,
    }),
  });

  if (response.status === 401) {
    if (!REGISTRATION_TOKEN || registrationUsed) {
      throw new Error("Agent credentials were rejected. Reinstall the agent.");
    }

    const next = await registerAgent(docker);
    return next.config;
  }

  if (!response.ok) {
    throw new Error(`Heartbeat failed with status ${response.status}`);
  }

  const body = (await response.json()) as AgentHeartbeatResponse;
  return body.config;
}

function buildProjectNetwork(projectId: string): string {
  return `nouva-project-${hashProjectNetwork(projectId)}`;
}

function buildLabels(input: {
  kind: string;
  projectId?: string | null;
  serviceId?: string | null;
  deploymentId?: string | null;
}): Record<string, string> {
  return {
    "nouva.managed": "true",
    "nouva.server.id": SERVER_ID!,
    "nouva.kind": input.kind,
    ...(input.projectId ? { "nouva.project.id": input.projectId } : {}),
    ...(input.serviceId ? { "nouva.service.id": input.serviceId } : {}),
    ...(input.deploymentId ? { "nouva.deployment.id": input.deploymentId } : {}),
  };
}

async function ensureBaseRuntime(
  docker: DockerApiClient,
  config: AgentRuntimeConfig
): Promise<void> {
  await mkdir(TRAEFIK_DYNAMIC_DIR, { recursive: true });
  await docker.ensureNetwork(config.localTraefikNetwork);

  await docker.ensureContainer({
    name: LOCAL_REGISTRY_CONTAINER_NAME,
    image: "registry:2",
    labels: buildLabels({ kind: "registry" }),
    exposedPorts: {
      "5000/tcp": {},
    },
    hostConfig: {
      PortBindings: {
        "5000/tcp": [
          {
            HostIp: "127.0.0.1",
            HostPort: String(config.localRegistryPort),
          },
        ],
      },
      RestartPolicy: {
        Name: "unless-stopped",
      },
    },
  });

  await docker.ensureContainer({
    name: BUILDKIT_CONTAINER_NAME,
    image: "moby/buildkit:v0.17.0",
    cmd: ["--addr", "tcp://0.0.0.0:1234"],
    labels: buildLabels({ kind: "buildkit" }),
    exposedPorts: {
      "1234/tcp": {},
    },
    hostConfig: {
      Privileged: true,
      PortBindings: {
        "1234/tcp": [
          {
            HostIp: "127.0.0.1",
            HostPort: "1234",
          },
        ],
      },
      RestartPolicy: {
        Name: "unless-stopped",
      },
    },
  });

  await docker.ensureContainer({
    name: TRAEFIK_CONTAINER_NAME,
    image: "traefik:v3.0",
    cmd: [
      "--entrypoints.web.address=:80",
      "--providers.file.directory=/var/lib/nouva-agent/traefik/dynamic",
      "--providers.file.watch=true",
    ],
    labels: buildLabels({ kind: "ingress" }),
    exposedPorts: {
      "80/tcp": {},
    },
    hostConfig: {
      Binds: [`${DATA_VOLUME}:/var/lib/nouva-agent`],
      PortBindings: {
        "80/tcp": [
          {
            HostIp: "0.0.0.0",
            HostPort: "80",
          },
        ],
      },
      RestartPolicy: {
        Name: "unless-stopped",
      },
    },
    networkingConfig: {
      EndpointsConfig: {
        [config.localTraefikNetwork]: {},
      },
    },
  });
}

async function writeLocalRouteFile(
  serviceId: string,
  hostnames: string[],
  serviceUrl: string
): Promise<void> {
  await mkdir(TRAEFIK_DYNAMIC_DIR, { recursive: true });
  const fileName = path.join(TRAEFIK_DYNAMIC_DIR, `${serviceId}.yml`);
  await writeFile(
    fileName,
    buildLocalHttpRouteConfig({
      fileKey: serviceId,
      hostnames,
      serviceUrl,
    }),
    "utf8"
  );
}

async function deleteLocalRouteFile(serviceId: string): Promise<void> {
  try {
    await rm(path.join(TRAEFIK_DYNAMIC_DIR, `${serviceId}.yml`), { force: true });
  } catch {}
}

function resolveAppPort(
  payloadEnvVars: Record<string, string>,
  metadataPort: number | null
): number {
  const envPort = Number(payloadEnvVars.PORT);
  if (Number.isInteger(envPort) && envPort >= 1 && envPort <= 65535) {
    return envPort;
  }

  if (
    metadataPort &&
    Number.isInteger(metadataPort) &&
    metadataPort >= 1 &&
    metadataPort <= 65535
  ) {
    return metadataPort;
  }

  return 3000;
}

async function deployAppImage(
  docker: DockerApiClient,
  config: AgentRuntimeConfig,
  payload: {
    projectId: string;
    serviceId: string;
    deploymentId: string;
    serviceName: string;
    subdomain: string;
    envVars: Record<string, string>;
    imageUrl: string;
    runtimeMetadata?: RuntimeMetadata | null;
    detectedLanguage?: string | null;
    detectedFramework?: string | null;
    languageVersion?: string | null;
    internalPort?: number | null;
    buildDuration?: number | null;
  }
) {
  await ensureBaseRuntime(docker, config);

  const projectNetwork = buildProjectNetwork(payload.projectId);
  await docker.ensureNetwork(projectNetwork);

  const previousContainer =
    payload.runtimeMetadata?.containerName ?? payload.runtimeMetadata?.containerId ?? null;
  if (previousContainer) {
    await docker.removeContainer(previousContainer, true);
  }

  const containerName = `nouva-app-${payload.serviceId.slice(0, 8)}-${payload.deploymentId.slice(0, 8)}`;
  const appPort = resolveAppPort(payload.envVars, payload.internalPort ?? null);
  const containerId = await docker.ensureContainer(
    {
      name: containerName,
      image: payload.imageUrl,
      env: Object.entries(payload.envVars).map(([key, value]) => `${key}=${value}`),
      labels: buildLabels({
        kind: "app",
        projectId: payload.projectId,
        serviceId: payload.serviceId,
        deploymentId: payload.deploymentId,
      }),
      hostConfig: {
        RestartPolicy: {
          Name: "unless-stopped",
        },
      },
      networkingConfig: {
        EndpointsConfig: {
          [config.localTraefikNetwork]: {},
        },
      },
    },
    true
  );
  await docker.connectNetwork(projectNetwork, containerId).catch((err: Error) => {
    console.error(
      `[nouva-agent] connectNetwork failed for service ${payload.serviceId}: ${err.message}`
    );
  });

  const hostnames = [`${payload.subdomain}.${APP_DOMAIN}`];
  await writeLocalRouteFile(payload.serviceId, hostnames, `http://${containerName}:${appPort}`);

  return {
    imageUrl: payload.imageUrl,
    buildDuration: payload.buildDuration ?? null,
    detectedLanguage: payload.detectedLanguage ?? null,
    detectedFramework: payload.detectedFramework ?? null,
    languageVersion: payload.languageVersion ?? null,
    internalHost: containerName,
    internalPort: appPort,
    externalHost: `${payload.subdomain}.${APP_DOMAIN}`,
    runtimeMetadata: {
      containerId,
      containerName,
      image: payload.imageUrl,
      ingressHost: `${payload.subdomain}.${APP_DOMAIN}`,
      ingressPort: 80,
      internalPort: appPort,
    },
    runtimeInstance: {
      kind: "app",
      status: "running",
      name: containerName,
      image: payload.imageUrl,
      containerId,
      containerName,
      networkName: projectNetwork,
      internalHost: containerName,
      internalPort: appPort,
      externalHost: `${payload.subdomain}.${APP_DOMAIN}`,
      externalPort: 80,
    },
  };
}

async function handleBuildAndDeployApp(
  docker: DockerApiClient,
  config: AgentRuntimeConfig,
  payload: AppDeployPayload
) {
  const buildResult = await buildApp({
    repoUrl: payload.repoUrl,
    commitHash: payload.commitHash,
    deploymentId: payload.deploymentId,
    envVars: payload.envVars,
    localRegistryHost: config.localRegistryHost,
    localRegistryPort: config.localRegistryPort,
    buildkitAddress: BUILDKIT_ADDRESS,
  });

  return await deployAppImage(docker, config, {
    ...payload,
    imageUrl: buildResult.imageUrl,
    buildDuration: buildResult.buildDuration,
    detectedLanguage: buildResult.detectedLanguage,
    detectedFramework: buildResult.detectedFramework,
    languageVersion: buildResult.languageVersion,
    internalPort: buildResult.internalPort,
  });
}

async function handleDeployOnlyApp(
  docker: DockerApiClient,
  config: AgentRuntimeConfig,
  payload: DeployOnlyPayload
) {
  return await deployAppImage(docker, config, {
    ...payload,
    serviceName: payload.serviceId,
  });
}

async function handleDatabaseProvision(docker: DockerApiClient, payload: DatabaseProvisionPayload) {
  const projectNetwork = buildProjectNetwork(payload.projectId);
  await docker.ensureNetwork(projectNetwork);

  const imageConfig = getImageConfig(payload.variant);
  const image = `${imageConfig.image}:${payload.version}`;
  const volumeName = `nouva-vol-${payload.serviceId.slice(0, 12)}`;
  const credentials = toServiceCredentials(payload.credentials);
  await docker.createVolume(volumeName);

  const envVars = imageConfig.getEnvVars(credentials, {
    serviceId: payload.serviceId,
    projectId: payload.projectId,
    volumeId: volumeName,
  });
  const containerName = `nouva-${payload.variant}-${payload.serviceId.slice(0, 12)}`;
  const containerId = await docker.ensureContainer(
    {
      name: containerName,
      image,
      env: Object.entries(envVars).map(([key, value]) => `${key}=${value}`),
      cmd: imageConfig.getArgs?.(credentials),
      labels: buildLabels({
        kind: "database",
        projectId: payload.projectId,
        serviceId: payload.serviceId,
      }),
      exposedPorts: {
        [`${imageConfig.defaultPort}/tcp`]: {},
      },
      hostConfig: {
        Mounts: [
          {
            Type: "volume",
            Source: volumeName,
            Target: imageConfig.dataPath,
          },
        ],
        RestartPolicy: {
          Name: "unless-stopped",
        },
        ...(payload.publicAccessEnabled && payload.externalPort
          ? {
              PortBindings: {
                [`${imageConfig.defaultPort}/tcp`]: [
                  {
                    HostIp: "0.0.0.0",
                    HostPort: String(payload.externalPort),
                  },
                ],
              },
            }
          : {}),
      },
      networkingConfig: {
        EndpointsConfig: {
          [projectNetwork]: {},
        },
      },
    },
    true
  );

  return {
    internalHost: containerName,
    internalPort: imageConfig.defaultPort,
    externalHost: payload.publicAccessEnabled ? payload.externalHost : null,
    externalPort: payload.publicAccessEnabled ? payload.externalPort : null,
    runtimeMetadata: {
      containerId,
      containerName,
      image,
      publishedPort: payload.publicAccessEnabled ? payload.externalPort : null,
    },
    runtimeInstance: {
      kind: "database",
      status: "running",
      name: containerName,
      image,
      containerId,
      containerName,
      networkName: projectNetwork,
      internalHost: containerName,
      internalPort: imageConfig.defaultPort,
      externalHost: payload.publicAccessEnabled ? payload.externalHost : null,
      externalPort: payload.publicAccessEnabled ? payload.externalPort : null,
    },
  };
}

async function handleRestart(docker: DockerApiClient, runtimeMetadata: RuntimeMetadata | null) {
  const identifier = runtimeMetadata?.containerId ?? runtimeMetadata?.containerName;
  if (!identifier) {
    throw new Error("Missing runtime metadata for restart");
  }

  await docker.restartContainer(identifier);
  return {
    runtimeMetadata,
  };
}

async function handleRemove(
  docker: DockerApiClient,
  serviceId: string,
  runtimeMetadata: RuntimeMetadata | null
) {
  const identifier = runtimeMetadata?.containerId ?? runtimeMetadata?.containerName;
  if (identifier) {
    await docker.removeContainer(identifier, true);
  }
  await deleteLocalRouteFile(serviceId);
  return {
    runtimeInstance: {
      kind: "app",
      status: "removed",
      containerId: runtimeMetadata?.containerId ?? null,
      containerName: runtimeMetadata?.containerName ?? null,
    },
  };
}

async function handleDeleteService(
  docker: DockerApiClient,
  serviceId: string,
  runtimeMetadata: RuntimeMetadata | null
) {
  const identifier = runtimeMetadata?.containerId ?? runtimeMetadata?.containerName;
  if (identifier) {
    await docker.removeContainer(identifier, true);
  }

  await deleteLocalRouteFile(serviceId);
  return {
    runtimeInstance: {
      kind: "database",
      status: "removed",
      containerId: runtimeMetadata?.containerId ?? null,
      containerName: runtimeMetadata?.containerName ?? null,
    },
  };
}

async function handleSyncRouting(
  payload: SyncRoutingPayload & { runtimeMetadata?: RuntimeMetadata | null }
) {
  const runtimeMetadata = payload.runtimeMetadata ?? null;
  const containerName = runtimeMetadata?.containerName;
  if (!containerName) {
    throw new Error("Missing runtime metadata for routing sync");
  }

  const hostnames = [
    ...(payload.subdomain ? [`${payload.subdomain}.${APP_DOMAIN}`] : []),
    ...payload.verifiedDomains.map((domain) => domain.domain),
  ];
  const internalPort =
    typeof runtimeMetadata.internalPort === "number"
      ? runtimeMetadata.internalPort
      : (payload.ingressPort ?? 3000);

  await writeLocalRouteFile(
    payload.serviceId,
    hostnames,
    `http://${containerName}:${internalPort}`
  );
  return {
    runtimeMetadata: {
      ...runtimeMetadata,
      configVersion:
        typeof runtimeMetadata.configVersion === "number" ? runtimeMetadata.configVersion + 1 : 1,
    },
  };
}

async function handleUpdateAgent(
  docker: DockerApiClient,
  payload: UpdateAgentPayload
): Promise<Record<string, unknown>> {
  const { imageTag } = payload;

  // Pull the new image before anything else
  await docker.pullImage(imageTag);

  // Collect NOUVA_ env keys — only safe identifier names go in the shell string
  const nouvaEnvKeys = Object.keys(process.env).filter((k) => k.startsWith("NOUVA_"));

  // Values are passed securely via the Docker API Env field — never interpolated into shell
  const updaterEnv: string[] = [
    ...nouvaEnvKeys.map((k) => `${k}=${process.env[k] ?? ""}`),
    `NOUVA_AGENT_TARGET_IMAGE=${imageTag}`,
  ];

  // Only key names (safe identifiers) appear in the shell string; values come from container env
  const envInheritFlags = [...nouvaEnvKeys, "NOUVA_AGENT_TARGET_IMAGE"]
    .map((k) => `-e ${k}`)
    .join(" ");

  // Build the shell command that runs AFTER we report success
  const updateCmd = [
    "sleep 5",
    "docker stop nouva-agent || true",
    "docker rm nouva-agent || true",
    `docker run -d --name nouva-agent --restart unless-stopped --network host` +
      ` -v /var/run/docker.sock:/var/run/docker.sock -v /:/hostfs:ro` +
      ` -v "$NOUVA_AGENT_DATA_VOLUME:/var/lib/nouva-agent"` +
      ` ${envInheritFlags} "$NOUVA_AGENT_TARGET_IMAGE"`,
  ].join(" && ");

  // Spawn ephemeral updater (auto-removed), fires after we return
  await docker.ensureContainer(
    {
      name: "nouva-agent-updater",
      image: "docker:cli",
      cmd: ["sh", "-c", updateCmd],
      env: updaterEnv,
      hostConfig: {
        AutoRemove: true,
        NetworkMode: "host",
        Binds: ["/var/run/docker.sock:/var/run/docker.sock"],
      },
    },
    true // replace any previous updater
  );

  return { scheduled: true, imageTag, scheduledAt: new Date().toISOString() };
}

async function processWorkItem(
  docker: DockerApiClient,
  config: AgentRuntimeConfig,
  credentials: StoredCredentials,
  workItem: AgentWorkRecord
) {
  console.log(`[nouva-agent] processing work ${workItem.id} (${workItem.kind})`);
  const payload = toObject(workItem.payload);

  let result: Record<string, unknown> | undefined;
  let workError: Error | null = null;

  try {
    switch (workItem.kind) {
      case "deploy_app":
      case "redeploy_app":
        result = await handleBuildAndDeployApp(
          docker,
          config,
          payload as unknown as AppDeployPayload
        );
        break;
      case "rollback_app":
        result = await handleDeployOnlyApp(docker, config, payload as unknown as DeployOnlyPayload);
        break;
      case "restart_app":
      case "restart_database":
        result = await handleRestart(docker, toRuntimeMetadata(payload.runtimeMetadata));
        break;
      case "remove_app":
        result = await handleRemove(
          docker,
          String(payload.serviceId),
          toRuntimeMetadata(payload.runtimeMetadata)
        );
        break;
      case "provision_database":
        result = await handleDatabaseProvision(
          docker,
          payload as unknown as DatabaseProvisionPayload
        );
        break;
      case "delete_service":
        result = await handleDeleteService(
          docker,
          String(payload.serviceId),
          toRuntimeMetadata(payload.runtimeMetadata)
        );
        break;
      case "sync_routing":
        result = await handleSyncRouting({
          ...(payload as unknown as SyncRoutingPayload),
          runtimeMetadata: toRuntimeMetadata(payload.runtimeMetadata),
        });
        break;
      case "update_agent":
        result = await handleUpdateAgent(docker, toUpdateAgentPayload(payload));
        break;
      default:
        throw new Error(`Unsupported work kind: ${workItem.kind}`);
    }
  } catch (err) {
    workError = err instanceof Error ? err : new Error("Unknown agent work failure");
  }

  if (workError) {
    try {
      await apiRequest(`/api/agent/work/${workItem.id}/fail`, {
        method: "POST",
        token: credentials.agentToken,
        body: {
          serverId: SERVER_ID!,
          leaseId: workItem.leaseId,
          errorMessage: workError.message,
        },
      });
    } catch (reportErr) {
      console.error(`[nouva-agent] failed to report failure for work ${workItem.id}:`, reportErr);
    }
    return;
  }

  try {
    await apiRequest(`/api/agent/work/${workItem.id}/complete`, {
      method: "POST",
      token: credentials.agentToken,
      body: {
        serverId: SERVER_ID!,
        leaseId: workItem.leaseId,
        result: result!,
      },
    });
    console.log(`[nouva-agent] work ${workItem.id} (${workItem.kind}) completed`);
  } catch (reportErr) {
    // Work succeeded locally. Don't call /fail — let lease expire so the item can be retried.
    console.error(`[nouva-agent] work ${workItem.id} succeeded but /complete failed:`, reportErr);
  }
}

async function collectMetrics(docker: DockerApiClient): Promise<AgentMetricsEnvelope> {
  const [currentCpuStat, previousCpuStat, meminfo, loadavg] = await Promise.all([
    readFile("/hostfs/proc/stat", "utf8"),
    readFile(path.join(DATA_DIR, "last-cpu-stat"), "utf8").catch(() => ""),
    readFile("/hostfs/proc/meminfo", "utf8"),
    readFile("/hostfs/proc/loadavg", "utf8").catch(() => ""),
  ]);

  const stats = await statfs("/hostfs");
  const serverMetrics = parseHostMetricsSnapshot({
    currentCpuStat,
    previousCpuStat,
    meminfo,
    loadavg,
    diskAvailableBytes: Number(stats.bavail) * Number(stats.bsize),
    diskTotalBytes: Number(stats.blocks) * Number(stats.bsize),
  });
  await writeFile(path.join(DATA_DIR, "last-cpu-stat"), currentCpuStat);

  const containers = await docker.listManagedContainers();
  const services = [];
  for (const container of containers) {
    if (container.State !== "running") {
      continue;
    }

    const labels = container.Labels ?? {};
    const serviceId = labels["nouva.service.id"];
    if (!serviceId) {
      continue;
    }

    const parsed = await docker.containerStats(container.Id);
    services.push({
      serviceId,
      deploymentId: labels["nouva.deployment.id"] ?? null,
      runtimeInstanceId: null,
      ...parsed,
      raw: null,
      collectedAt: new Date().toISOString(),
    });
  }

  return {
    server: serverMetrics,
    services,
  };
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  const docker = await DockerApiClient.create();
  let credentials = await readCredentials();
  let config = getAgentRuntimeConfig();

  if (!credentials?.agentToken) {
    const registered = await registerAgent(docker);
    credentials = registered.credentials;
    config = registered.config;
  }

  config = await sendHeartbeat(docker, credentials);
  let workLoopActive = false;
  let isShuttingDown = false;

  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log("[nouva-agent] shutting down, draining work loop...");
    const deadline = Date.now() + 9_000;
    while (workLoopActive && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });

  let heartbeatFailures = 0;
  const MAX_HEARTBEAT_FAILURES = 5;

  setInterval(() => {
    sendHeartbeat(docker, credentials!)
      .then((nextConfig) => {
        config = nextConfig;
        heartbeatFailures = 0;
      })
      .catch((error) => {
        heartbeatFailures++;
        console.error(
          `[nouva-agent] heartbeat failed (${heartbeatFailures}/${MAX_HEARTBEAT_FAILURES})`,
          error
        );
        if (heartbeatFailures >= MAX_HEARTBEAT_FAILURES) {
          console.error("[nouva-agent] too many heartbeat failures, exiting");
          process.exit(1);
        }
      });
  }, config.heartbeatIntervalSeconds * 1000);

  setInterval(() => {
    collectMetrics(docker)
      .then((metrics) =>
        apiRequest("/api/agent/metrics", {
          method: "POST",
          token: credentials!.agentToken,
          body: {
            serverId: SERVER_ID!,
            ...metrics,
          } satisfies AgentMetricsRequest,
        })
      )
      .catch((error) => {
        console.error("[nouva-agent] metrics failed", error);
      });
  }, config.metricsIntervalSeconds * 1000);

  setInterval(async () => {
    if (workLoopActive || isShuttingDown) {
      return;
    }

    workLoopActive = true;
    try {
      const leased = await apiRequest<AgentLeaseResponse>("/api/agent/work/lease", {
        method: "POST",
        token: credentials!.agentToken,
        body: {
          serverId: SERVER_ID!,
          limit: 5,
        },
      });

      config = leased.config;
      for (const workItem of leased.workItems) {
        await processWorkItem(docker, config, credentials!, workItem);
      }
    } catch (error) {
      console.error("[nouva-agent] work loop failed", error);
    } finally {
      workLoopActive = false;
    }
  }, config.pollIntervalSeconds * 1000);
}

main().catch((error) => {
  console.error("[nouva-agent] fatal", error);
  process.exit(1);
});
