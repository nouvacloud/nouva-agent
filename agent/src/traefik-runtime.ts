import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type {
  DockerApiClient,
  DockerContainerInspection,
  DockerContainerSpec,
} from "./docker-api.js";
import type { AgentRuntimeConfig, ServerCheckStatus, ServerValidationCheck } from "./protocol.js";

export const TRAEFIK_IMAGE = process.env.NOUVA_AGENT_TRAEFIK_IMAGE || "traefik:v3.5";
export const DEFAULT_TRAEFIK_IMAGE = TRAEFIK_IMAGE;
export const TRAEFIK_CONTAINER_NAME = process.env.NOUVA_AGENT_TRAEFIK_CONTAINER || "nouva-traefik";
export const TRAEFIK_CANDIDATE_CONTAINER_NAME = `${TRAEFIK_CONTAINER_NAME}-candidate`;
export const TRAEFIK_ADMIN_HOST = "127.0.0.1";
export const TRAEFIK_ADMIN_PORT = 8082;
export const TRAEFIK_CANDIDATE_ADMIN_PORT = 8083;
export const TRAEFIK_CONFIG_HASH_LABEL = "nouva.traefik.static-config-sha";
export const TRAEFIK_ROLE_LABEL = "nouva.traefik.role";
export const TRAEFIK_API_ENTRYPOINT = "traefik";

const AGENT_DATA_DIR_IN_CONTAINER = "/var/lib/nouva-agent";
const ACME_FILE_MODE = 0o600;

export interface TraefikRuntimePaths {
  rootDir: string;
  staticDir: string;
  dynamicDir: string;
  acmeDir: string;
  staticConfigPath: string;
  acmeStoragePath: string;
}

export interface TraefikRouteConfig {
  fileKey: string;
  hostnames: string[];
  serviceUrl: string;
}

export interface TraefikRuntimeFailure {
  phase: "preflight" | "cutover" | "rollback";
  message: string;
  at: string;
  rollbackStatus: "not-needed" | "succeeded" | "failed";
}

export interface TraefikRuntimeInput {
  dataDir: string;
  dataVolume: string;
  containerName: string;
  networkName: string;
  serverId: string;
  image: string;
  acmeEmail: string | null;
}

export interface TraefikRuntimeDeps {
  paths?: TraefikRuntimePaths;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  intervalMs?: number;
}

interface BuildTraefikContainerSpecOptions {
  dataVolume: string;
  labels?: Record<string, string>;
  name?: string;
  image?: string;
  publicBindings?: boolean;
  adminHostPort?: number;
  stateHash: string;
}

interface ProbeTraefikRuntimeOptions {
  containerName?: string;
  adminPort?: number;
  fetchImpl?: typeof fetch;
}

interface WaitForTraefikHealthOptions extends ProbeTraefikRuntimeOptions {
  expectPublicBindings: boolean;
  timeoutMs: number;
  intervalMs: number;
}

interface ReconcileTraefikRuntimeOptions {
  dataVolume: string;
  labels?: Record<string, string>;
  paths?: TraefikRuntimePaths;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  intervalMs?: number;
}

interface CollectTraefikValidationChecksOptions {
  paths?: TraefikRuntimePaths;
  fetchImpl?: typeof fetch;
}

interface TraefikProbeResult {
  inspection: DockerContainerInspection | null;
  pingOk: boolean;
  routeFileCount: number;
  managedRouterCount: number | null;
  acmeStatus: ServerCheckStatus;
  acmeMessage: string;
  acmeMode: string | null;
}

let lastTraefikRuntimeFailure: TraefikRuntimeFailure | null = null;

function buildCheck(
  key: string,
  label: string,
  status: ServerCheckStatus,
  message: string,
  value: string | null = null
): ServerValidationCheck {
  return { key, label, status, message, value };
}

function serializeYaml(lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

function quoteHostnames(hostnames: string[]): string {
  return hostnames.map((hostname) => `Host(\`${hostname}\`)`).join(" || ");
}

function formatMode(mode: number): string {
  return `0${(mode & 0o777).toString(8)}`;
}

function buildTraefikRuntimeConfig(networkName: string): AgentRuntimeConfig {
  return {
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
    },
    localRegistryHost: "127.0.0.1",
    localRegistryPort: 5000,
    localTraefikNetwork: networkName,
  };
}

function buildTraefikLabels(input: TraefikRuntimeInput): Record<string, string> {
  return {
    "nouva.managed": "true",
    "nouva.kind": "traefik",
    "nouva.server.id": input.serverId,
  };
}

function resolveValidationOptions(
  inputOrOptions: TraefikRuntimeInput | CollectTraefikValidationChecksOptions | undefined,
  deps: CollectTraefikValidationChecksOptions | undefined
): CollectTraefikValidationChecksOptions {
  if (inputOrOptions && "dataDir" in inputOrOptions && typeof inputOrOptions.dataDir === "string") {
    return {
      ...deps,
      paths: deps?.paths ?? getTraefikRuntimePaths(inputOrOptions.dataDir),
    };
  }

  if (!inputOrOptions) {
    return {};
  }

  return inputOrOptions as CollectTraefikValidationChecksOptions;
}

function hasPortBinding(
  inspection: DockerContainerInspection | null,
  containerPort: string,
  expected: { hostIp: string; hostPort: string }
): boolean {
  const bindings = inspection?.HostConfig?.PortBindings?.[containerPort];
  if (!Array.isArray(bindings)) {
    return false;
  }

  return bindings.some(
    (binding) =>
      binding.HostPort === expected.hostPort &&
      (binding.HostIp === expected.hostIp ||
        (expected.hostIp === "0.0.0.0" && (binding.HostIp === "0.0.0.0" || binding.HostIp === "")))
  );
}

function hasPrimaryPortBindings(inspection: DockerContainerInspection | null): boolean {
  return (
    hasPortBinding(inspection, "80/tcp", { hostIp: "0.0.0.0", hostPort: "80" }) &&
    hasPortBinding(inspection, "443/tcp", { hostIp: "0.0.0.0", hostPort: "443" })
  );
}

function hasAdminBinding(
  inspection: DockerContainerInspection | null,
  adminHostPort: number
): boolean {
  return hasPortBinding(inspection, "8082/tcp", {
    hostIp: TRAEFIK_ADMIN_HOST,
    hostPort: String(adminHostPort),
  });
}

function isTraefikContainerCurrent(
  inspection: DockerContainerInspection | null,
  stateHash: string
): boolean {
  return (
    inspection?.State?.Running === true &&
    inspection.Config?.Image === TRAEFIK_IMAGE &&
    inspection.Config?.Labels?.[TRAEFIK_CONFIG_HASH_LABEL] === stateHash &&
    hasPrimaryPortBindings(inspection) &&
    hasAdminBinding(inspection, TRAEFIK_ADMIN_PORT)
  );
}

async function writeManagedFile(filePath: string, contents: string, mode?: number): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, contents, "utf8");
  if (typeof mode === "number") {
    await chmod(tempPath, mode);
  }
  await rename(tempPath, filePath);
  if (typeof mode === "number") {
    await chmod(filePath, mode);
  }
}

async function countRouteFiles(dynamicDir: string): Promise<number> {
  try {
    const entries = await readdir(dynamicDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".yml")).length;
  } catch {
    return 0;
  }
}

async function fetchManagedRouterCount(
  fetchImpl: typeof fetch,
  adminPort: number
): Promise<number | null> {
  const response = await fetchImpl(`http://${TRAEFIK_ADMIN_HOST}:${adminPort}/api/http/routers`);
  if (!response.ok) {
    return null;
  }

  const routers = (await response.json()) as Array<{
    name?: string;
    provider?: string;
    rule?: string;
  }>;

  return routers.filter((router) => {
    if (typeof router.rule !== "string" || !router.rule.includes("Host(`")) {
      return false;
    }

    return router.provider === "file" || router.name?.endsWith("@file");
  }).length;
}

async function probeTraefikRuntime(
  docker: DockerApiClient,
  paths: TraefikRuntimePaths,
  options: ProbeTraefikRuntimeOptions = {}
): Promise<TraefikProbeResult> {
  const inspection = await docker.inspectContainer(options.containerName ?? TRAEFIK_CONTAINER_NAME);
  const fetchImpl = options.fetchImpl ?? fetch;
  const adminPort = options.adminPort ?? TRAEFIK_ADMIN_PORT;
  const routeFileCount = await countRouteFiles(paths.dynamicDir);

  let pingOk = false;
  let managedRouterCount: number | null = null;

  if (inspection?.State?.Running) {
    try {
      const pingResponse = await fetchImpl(`http://${TRAEFIK_ADMIN_HOST}:${adminPort}/ping`);
      pingOk = pingResponse.ok;
    } catch {
      pingOk = false;
    }

    try {
      managedRouterCount = await fetchManagedRouterCount(fetchImpl, adminPort);
    } catch {
      managedRouterCount = null;
    }
  }

  let acmeStatus: ServerCheckStatus = "fail";
  let acmeMessage = "ACME storage is missing";
  let acmeMode: string | null = null;

  try {
    await access(paths.acmeStoragePath, fsConstants.R_OK | fsConstants.W_OK);
    const stats = await stat(paths.acmeStoragePath);
    acmeMode = formatMode(stats.mode);
    acmeStatus = (stats.mode & 0o777) === ACME_FILE_MODE ? "pass" : "warn";
    acmeMessage =
      acmeStatus === "pass"
        ? "ACME storage is readable, writable, and mode 0600"
        : `ACME storage is readable and writable but mode is ${acmeMode}`;
  } catch (error) {
    acmeStatus = "fail";
    acmeMessage = error instanceof Error ? error.message : "ACME storage is not accessible";
  }

  return {
    inspection,
    pingOk,
    routeFileCount,
    managedRouterCount,
    acmeStatus,
    acmeMessage,
    acmeMode,
  };
}

async function waitForTraefikHealth(
  docker: DockerApiClient,
  paths: TraefikRuntimePaths,
  options: WaitForTraefikHealthOptions
): Promise<void> {
  const startedAt = Date.now();
  let lastError = "Traefik runtime did not become healthy";

  while (Date.now() - startedAt < options.timeoutMs) {
    const probe = await probeTraefikRuntime(docker, paths, {
      containerName: options.containerName,
      adminPort: options.adminPort,
      fetchImpl: options.fetchImpl,
    });

    if (!probe.inspection?.State?.Running) {
      lastError = "Traefik container is not running";
    } else if (options.expectPublicBindings && !hasPrimaryPortBindings(probe.inspection)) {
      lastError = "Traefik public port bindings are incomplete";
    } else if (!hasAdminBinding(probe.inspection, options.adminPort ?? TRAEFIK_ADMIN_PORT)) {
      lastError = "Traefik admin binding is missing";
    } else if (!probe.pingOk) {
      lastError = "Traefik ping endpoint is not healthy";
    } else if (probe.acmeStatus === "fail") {
      lastError = probe.acmeMessage;
    } else if (
      probe.routeFileCount > 0 &&
      (probe.managedRouterCount === null || probe.managedRouterCount < probe.routeFileCount * 2)
    ) {
      lastError = "Traefik has not loaded all file-provider routes";
    } else {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
  }

  throw new Error(lastError);
}

function recordTraefikRuntimeFailure(
  failure: Pick<TraefikRuntimeFailure, "phase" | "message" | "rollbackStatus">
): void {
  lastTraefikRuntimeFailure = {
    ...failure,
    at: new Date().toISOString(),
  };
  console.error("[nouva-agent] traefik reconcile failure", lastTraefikRuntimeFailure);
}

export function resetTraefikRuntimeState(): void {
  lastTraefikRuntimeFailure = null;
}

export function getTraefikRuntimePaths(dataDir: string): TraefikRuntimePaths {
  const rootDir = path.join(dataDir, "traefik");
  return {
    rootDir,
    staticDir: path.join(rootDir, "static"),
    dynamicDir: path.join(rootDir, "dynamic"),
    acmeDir: path.join(rootDir, "acme"),
    staticConfigPath: path.join(rootDir, "static", "traefik.yml"),
    acmeStoragePath: path.join(rootDir, "acme", "acme.json"),
  };
}

export function buildTraefikRuntimePaths(dataDir: string): TraefikRuntimePaths {
  return getTraefikRuntimePaths(dataDir);
}

export async function ensureTraefikState(paths: TraefikRuntimePaths): Promise<void> {
  await mkdir(paths.staticDir, { recursive: true });
  await mkdir(paths.dynamicDir, { recursive: true });
  await mkdir(paths.acmeDir, { recursive: true });

  try {
    const currentContent = await readFile(paths.acmeStoragePath, "utf8");
    if (!currentContent.trim()) {
      await writeManagedFile(paths.acmeStoragePath, "{}\n", ACME_FILE_MODE);
      return;
    }

    await chmod(paths.acmeStoragePath, ACME_FILE_MODE);
  } catch {
    await writeManagedFile(paths.acmeStoragePath, "{}\n", ACME_FILE_MODE);
  }
}

export function resolveRoutingHostnames(input: {
  providedHostname?: string | null;
  customHostnames?: string[] | null;
}): string[] {
  const seen = new Set<string>();
  const hostnames: string[] = [];

  for (const rawHostname of [input.providedHostname, ...(input.customHostnames ?? [])]) {
    const hostname = typeof rawHostname === "string" ? rawHostname.trim().toLowerCase() : "";
    if (!hostname || seen.has(hostname)) {
      continue;
    }

    seen.add(hostname);
    hostnames.push(hostname);
  }

  return hostnames;
}

export function buildTraefikRouteConfig(route: TraefikRouteConfig): string {
  const httpRouterName = `http-${route.fileKey}`;
  const httpsRouterName = `https-${route.fileKey}`;
  const redirectMiddlewareName = `redirect-${route.fileKey}`;
  const serviceName = `svc-${route.fileKey}`;

  return serializeYaml([
    "http:",
    "  routers:",
    `    ${httpRouterName}:`,
    `      rule: "${quoteHostnames(route.hostnames)}"`,
    "      entryPoints:",
    "        - web",
    "      middlewares:",
    `        - ${redirectMiddlewareName}`,
    `      service: ${serviceName}`,
    `    ${httpsRouterName}:`,
    `      rule: "${quoteHostnames(route.hostnames)}"`,
    "      entryPoints:",
    "        - websecure",
    `      service: ${serviceName}`,
    "      tls:",
    "        certResolver: letsencrypt",
    "  middlewares:",
    `    ${redirectMiddlewareName}:`,
    "      redirectScheme:",
    "        scheme: https",
    "        permanent: true",
    "  services:",
    `    ${serviceName}:`,
    "      loadBalancer:",
    "        passHostHeader: true",
    "        servers:",
    `          - url: ${route.serviceUrl}`,
  ]);
}

export function renderTraefikStaticConfig(paths: TraefikRuntimePaths): string {
  return serializeYaml([
    "api:",
    "  insecure: true",
    "  dashboard: true",
    "ping:",
    `  entryPoint: ${TRAEFIK_API_ENTRYPOINT}`,
    "entryPoints:",
    "  web:",
    '    address: ":80"',
    "  websecure:",
    '    address: ":443"',
    `  ${TRAEFIK_API_ENTRYPOINT}:`,
    '    address: ":8082"',
    "providers:",
    "  file:",
    `    directory: "${paths.dynamicDir}"`,
    "    watch: true",
    "certificatesResolvers:",
    "  letsencrypt:",
    "    acme:",
    `      storage: "${paths.acmeStoragePath}"`,
    "      httpChallenge:",
    "        entryPoint: web",
  ]);
}

export function createTraefikStateHash(staticConfig: string): string {
  return createHash("sha256").update(staticConfig).digest("hex");
}

export function buildTraefikContainerSpec(
  config: AgentRuntimeConfig,
  options: BuildTraefikContainerSpecOptions
): DockerContainerSpec {
  const publicBindings = options.publicBindings ?? true;
  const adminHostPort = options.adminHostPort ?? TRAEFIK_ADMIN_PORT;

  return {
    name: options.name ?? TRAEFIK_CONTAINER_NAME,
    image: options.image ?? TRAEFIK_IMAGE,
    cmd: [
      `--configFile=${path.posix.join(
        AGENT_DATA_DIR_IN_CONTAINER,
        "traefik",
        "static",
        "traefik.yml"
      )}`,
    ],
    labels: {
      ...(options.labels ?? {}),
      [TRAEFIK_CONFIG_HASH_LABEL]: options.stateHash,
      [TRAEFIK_ROLE_LABEL]: publicBindings ? "primary" : "candidate",
    },
    exposedPorts: {
      "80/tcp": {},
      "443/tcp": {},
      "8082/tcp": {},
    },
    hostConfig: {
      Binds: [`${options.dataVolume}:${AGENT_DATA_DIR_IN_CONTAINER}`],
      PortBindings: {
        ...(publicBindings
          ? {
              "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "80" }],
              "443/tcp": [{ HostIp: "0.0.0.0", HostPort: "443" }],
            }
          : {}),
        "8082/tcp": [
          {
            HostIp: TRAEFIK_ADMIN_HOST,
            HostPort: String(adminHostPort),
          },
        ],
      },
      RestartPolicy: {
        Name: publicBindings ? "unless-stopped" : "no",
      },
    },
    networkingConfig: {
      EndpointsConfig: {
        [config.localTraefikNetwork]: {},
      },
    },
  };
}

export async function writeTraefikRouteFile(
  paths: TraefikRuntimePaths,
  serviceId: string,
  hostnames: string[],
  serviceUrl: string
): Promise<void> {
  if (hostnames.length === 0) {
    await deleteTraefikRouteFile(paths, serviceId);
    return;
  }

  await writeManagedFile(
    path.join(paths.dynamicDir, `${serviceId}.yml`),
    buildTraefikRouteConfig({
      fileKey: serviceId,
      hostnames,
      serviceUrl,
    })
  );
}

export async function writeLocalTraefikRoute(
  paths: TraefikRuntimePaths,
  serviceId: string,
  hostnames: string[],
  serviceUrl: string
): Promise<void> {
  await writeTraefikRouteFile(paths, serviceId, hostnames, serviceUrl);
}

export async function deleteTraefikRouteFile(
  paths: TraefikRuntimePaths,
  serviceId: string
): Promise<void> {
  await rm(path.join(paths.dynamicDir, `${serviceId}.yml`), { force: true });
}

export async function deleteLocalTraefikRoute(
  paths: TraefikRuntimePaths,
  serviceId: string
): Promise<void> {
  await deleteTraefikRouteFile(paths, serviceId);
}

export async function reconcileTraefikRuntime(
  docker: DockerApiClient,
  config: AgentRuntimeConfig,
  options: ReconcileTraefikRuntimeOptions
): Promise<void> {
  const paths = options.paths ?? getTraefikRuntimePaths("/var/lib/nouva-agent");

  await ensureTraefikState(paths);
  await docker.ensureNetwork(config.localTraefikNetwork);

  const staticConfig = renderTraefikStaticConfig(paths);
  await writeManagedFile(paths.staticConfigPath, staticConfig);
  const stateHash = createTraefikStateHash(staticConfig);
  const current = await docker.inspectContainer(TRAEFIK_CONTAINER_NAME);

  if (isTraefikContainerCurrent(current, stateHash)) {
    lastTraefikRuntimeFailure = null;
    return;
  }

  const previousImage = current?.Config?.Image ?? null;
  await docker.pullImage(TRAEFIK_IMAGE);
  await docker.removeContainer(TRAEFIK_CANDIDATE_CONTAINER_NAME, true);

  await docker.ensureContainer(
    buildTraefikContainerSpec(config, {
      dataVolume: options.dataVolume,
      labels: options.labels,
      name: TRAEFIK_CANDIDATE_CONTAINER_NAME,
      publicBindings: false,
      adminHostPort: TRAEFIK_CANDIDATE_ADMIN_PORT,
      stateHash,
    }),
    true
  );

  try {
    await waitForTraefikHealth(docker, paths, {
      containerName: TRAEFIK_CANDIDATE_CONTAINER_NAME,
      adminPort: TRAEFIK_CANDIDATE_ADMIN_PORT,
      expectPublicBindings: false,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs ?? 15_000,
      intervalMs: options.intervalMs ?? 250,
    });
  } catch (error) {
    await docker.removeContainer(TRAEFIK_CANDIDATE_CONTAINER_NAME, true);
    recordTraefikRuntimeFailure({
      phase: "preflight",
      message: error instanceof Error ? error.message : "Traefik candidate preflight failed",
      rollbackStatus: "not-needed",
    });
    throw error;
  }

  await docker.removeContainer(TRAEFIK_CONTAINER_NAME, true);
  await docker.ensureContainer(
    buildTraefikContainerSpec(config, {
      dataVolume: options.dataVolume,
      labels: options.labels,
      stateHash,
    }),
    true
  );

  try {
    await waitForTraefikHealth(docker, paths, {
      containerName: TRAEFIK_CONTAINER_NAME,
      adminPort: TRAEFIK_ADMIN_PORT,
      expectPublicBindings: true,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs ?? 15_000,
      intervalMs: options.intervalMs ?? 250,
    });
    lastTraefikRuntimeFailure = null;
  } catch (error) {
    await docker.removeContainer(TRAEFIK_CONTAINER_NAME, true);

    let rollbackStatus: TraefikRuntimeFailure["rollbackStatus"] = "not-needed";
    if (previousImage) {
      try {
        await docker.ensureContainer(
          buildTraefikContainerSpec(config, {
            dataVolume: options.dataVolume,
            labels: options.labels,
            image: previousImage,
            stateHash,
          }),
          true
        );
        await waitForTraefikHealth(docker, paths, {
          containerName: TRAEFIK_CONTAINER_NAME,
          adminPort: TRAEFIK_ADMIN_PORT,
          expectPublicBindings: true,
          fetchImpl: options.fetchImpl,
          timeoutMs: options.timeoutMs ?? 15_000,
          intervalMs: options.intervalMs ?? 250,
        });
        rollbackStatus = "succeeded";
      } catch {
        rollbackStatus = "failed";
      }
    }

    recordTraefikRuntimeFailure({
      phase: "cutover",
      message: error instanceof Error ? error.message : "Traefik cutover failed",
      rollbackStatus,
    });
    throw error;
  } finally {
    await docker.removeContainer(TRAEFIK_CANDIDATE_CONTAINER_NAME, true);
  }
}

export async function collectTraefikValidationChecks(
  docker: DockerApiClient,
  inputOrOptions: TraefikRuntimeInput | CollectTraefikValidationChecksOptions = {},
  deps?: CollectTraefikValidationChecksOptions,
  bootstrapError?: Error | null
): Promise<ServerValidationCheck[]> {
  const options = resolveValidationOptions(inputOrOptions, deps);
  const paths = options.paths ?? getTraefikRuntimePaths("/var/lib/nouva-agent");
  const probe = await probeTraefikRuntime(docker, paths, {
    fetchImpl: options.fetchImpl,
  });

  const checks: ServerValidationCheck[] = [];
  checks.push(
    buildCheck(
      "traefik-image",
      "Traefik image",
      probe.inspection?.Config?.Image === TRAEFIK_IMAGE ? "pass" : "fail",
      probe.inspection?.Config?.Image === TRAEFIK_IMAGE
        ? `Running pinned image ${TRAEFIK_IMAGE}`
        : `Expected ${TRAEFIK_IMAGE}`,
      probe.inspection?.Config?.Image ?? null
    )
  );

  const containerStatus: ServerCheckStatus =
    probe.inspection?.State?.Running === true
      ? lastTraefikRuntimeFailure || bootstrapError
        ? "warn"
        : "pass"
      : "fail";
  const containerMessage =
    probe.inspection?.State?.Running === true
      ? lastTraefikRuntimeFailure
        ? `Traefik is running but the last reconcile failed during ${lastTraefikRuntimeFailure.phase}: ${lastTraefikRuntimeFailure.message} (rollback ${lastTraefikRuntimeFailure.rollbackStatus})`
        : bootstrapError
          ? `Traefik is running but reconcile failed: ${bootstrapError.message}`
          : "Traefik container is running"
      : "Traefik container is not running";

  checks.push(
    buildCheck(
      "traefik-container",
      "Traefik container",
      containerStatus,
      containerMessage,
      probe.inspection?.Name ?? null
    )
  );

  const port80Bound = hasPortBinding(probe.inspection, "80/tcp", {
    hostIp: "0.0.0.0",
    hostPort: "80",
  });
  checks.push(
    buildCheck(
      "traefik-port-80",
      "Traefik port 80",
      port80Bound ? "pass" : "fail",
      port80Bound ? "Traefik is bound on 0.0.0.0:80" : "Traefik is not bound on 0.0.0.0:80",
      "0.0.0.0:80"
    )
  );

  const port443Bound = hasPortBinding(probe.inspection, "443/tcp", {
    hostIp: "0.0.0.0",
    hostPort: "443",
  });
  checks.push(
    buildCheck(
      "traefik-port-443",
      "Traefik port 443",
      port443Bound ? "pass" : "fail",
      port443Bound ? "Traefik is bound on 0.0.0.0:443" : "Traefik is not bound on 0.0.0.0:443",
      "0.0.0.0:443"
    )
  );

  checks.push(
    buildCheck(
      "traefik-ping",
      "Traefik ping",
      probe.pingOk ? "pass" : "fail",
      probe.pingOk
        ? "Traefik ping endpoint responds on 127.0.0.1:8082"
        : "Traefik ping endpoint is not reachable on 127.0.0.1:8082",
      "127.0.0.1:8082"
    )
  );

  checks.push(
    buildCheck(
      "traefik-acme",
      "Traefik ACME storage",
      probe.acmeStatus,
      probe.acmeMessage,
      probe.acmeMode
    )
  );

  const routesStatus: ServerCheckStatus =
    probe.routeFileCount === 0
      ? "pass"
      : probe.managedRouterCount !== null && probe.managedRouterCount >= probe.routeFileCount * 2
        ? "pass"
        : "fail";
  const routesMessage =
    probe.routeFileCount === 0
      ? "No active Traefik route files are configured"
      : routesStatus === "pass"
        ? `Loaded ${probe.managedRouterCount} routers from ${probe.routeFileCount} route files`
        : `Expected ${probe.routeFileCount * 2} file-provider routers but found ${probe.managedRouterCount ?? 0}`;

  checks.push(
    buildCheck(
      "traefik-routes",
      "Traefik routes",
      routesStatus,
      routesMessage,
      String(probe.routeFileCount)
    )
  );

  return checks;
}

export async function ensureTraefikRuntime(
  docker: DockerApiClient,
  input: TraefikRuntimeInput,
  deps: TraefikRuntimeDeps = {}
): Promise<void> {
  await reconcileTraefikRuntime(docker, buildTraefikRuntimeConfig(input.networkName), {
    dataVolume: input.dataVolume,
    labels: buildTraefikLabels(input),
    paths: deps.paths ?? getTraefikRuntimePaths(input.dataDir),
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.timeoutMs,
    intervalMs: deps.intervalMs,
  });
}

export function buildUnavailableTraefikChecks(reason: string): ServerValidationCheck[] {
  return [
    buildCheck("traefik-image", "Traefik image", "fail", reason),
    buildCheck("traefik-container", "Traefik container", "fail", reason),
    buildCheck("traefik-port-80", "Traefik port 80", "fail", reason, "0.0.0.0:80"),
    buildCheck("traefik-port-443", "Traefik port 443", "fail", reason, "0.0.0.0:443"),
    buildCheck("traefik-ping", "Traefik ping", "fail", reason, "127.0.0.1:8082"),
    buildCheck("traefik-acme", "Traefik ACME storage", "fail", reason),
    buildCheck("traefik-routes", "Traefik routes", "fail", reason),
  ];
}
