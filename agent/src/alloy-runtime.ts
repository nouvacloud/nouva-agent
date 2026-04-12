import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  DockerApiClient,
  DockerContainerInspection,
  DockerContainerSpec,
} from "./docker-api.js";
import type { AgentRuntimeConfig, ServerCheckStatus, ServerValidationCheck } from "./protocol.js";

export const ALLOY_CONTAINER_NAME = "nouva-alloy";
export const ALLOY_HTTP_HOST = "127.0.0.1";
export const ALLOY_HTTP_PORT = 12345;
export const ALLOY_CONFIG_HASH_LABEL = "nouva.alloy.config-sha";
export const ALLOY_ROLE_LABEL = "nouva.alloy.role";

const AGENT_DATA_DIR_IN_CONTAINER = "/var/lib/nouva-agent";
const ALLOY_ROOT_DIR_IN_CONTAINER = `${AGENT_DATA_DIR_IN_CONTAINER}/alloy`;
const ALLOY_CONFIG_PATH_IN_CONTAINER = `${ALLOY_ROOT_DIR_IN_CONTAINER}/config.alloy`;
const ALLOY_DATA_DIR_IN_CONTAINER = `${ALLOY_ROOT_DIR_IN_CONTAINER}/data`;
const DOCKER_SOCKET = "/var/run/docker.sock";
const OBSERVABILITY_NONE_LABEL_VALUE = "__none__";
const OBSERVABILITY_DOCKER_LABELS = {
  managed: "__meta_docker_container_label_nouva_managed",
  kind: "__meta_docker_container_label_nouva_kind",
  projectId: "__meta_docker_container_label_nouva_project_id",
  serviceId: "__meta_docker_container_label_nouva_service_id",
  deploymentId: "__meta_docker_container_label_nouva_deployment_id",
  serviceVariant: "__meta_docker_container_label_nouva_service_variant",
  environmentId: "__meta_docker_container_label_nouva_environment_id",
  containerName: "__meta_docker_container_name",
} as const;

export interface AlloyRuntimePaths {
  rootDir: string;
  dataDir: string;
  configPath: string;
}

export interface AlloyRuntimeInput {
  dataDir: string;
  dataVolume: string;
  serverId: string;
  apiUrl: string;
  agentToken: string;
  config: AgentRuntimeConfig;
}

export interface AlloyRuntimeDeps {
  paths?: AlloyRuntimePaths;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  intervalMs?: number;
}

interface ReconcileAlloyRuntimeOptions {
  paths?: AlloyRuntimePaths;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  intervalMs?: number;
}

interface CollectAlloyValidationChecksOptions {
  paths?: AlloyRuntimePaths;
  fetchImpl?: typeof fetch;
}

interface AlloyProbeResult {
  configPresent: boolean;
  healthOk: boolean;
  imagePresent: boolean;
  inspection: DockerContainerInspection | null;
}

let lastAlloyRuntimeFailure: Error | null = null;

function buildCheck(
  key: string,
  label: string,
  status: ServerCheckStatus,
  message: string,
  value: string | null = null
): ServerValidationCheck {
  return { key, label, status, message, value };
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function list(values: string[]): string {
  return `[${values.map((value) => quote(value)).join(", ")}]`;
}

async function writeManagedFile(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, contents, "utf8");
  await rename(tempPath, filePath);
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

function hasRequiredBinds(inspection: DockerContainerInspection | null): boolean {
  const binds = inspection?.HostConfig?.Binds ?? [];
  const requiredPrefixes = [
    `${DOCKER_SOCKET}:${DOCKER_SOCKET}`,
    `/:/rootfs:ro`,
    `/sys:/sys:ro`,
    `/var/run:/var/run:ro`,
    `/var/lib/docker:/var/lib/docker:ro`,
    `:/var/lib/nouva-agent`,
  ];

  return requiredPrefixes.every((prefix) =>
    prefix.startsWith(":")
      ? binds.some((bind) => bind.endsWith(prefix.slice(1)))
      : binds.some((bind) => bind.startsWith(prefix))
  );
}

function isAlloyContainerCurrent(
  inspection: DockerContainerInspection | null,
  input: AlloyRuntimeInput,
  stateHash: string
): boolean {
  return (
    inspection?.State?.Running === true &&
    inspection.Config?.Image === input.config.observability.alloyImage &&
    inspection.Config?.Labels?.[ALLOY_CONFIG_HASH_LABEL] === stateHash &&
    hasPortBinding(inspection, `${ALLOY_HTTP_PORT}/tcp`, {
      hostIp: ALLOY_HTTP_HOST,
      hostPort: String(ALLOY_HTTP_PORT),
    }) &&
    hasRequiredBinds(inspection)
  );
}

async function probeAlloyRuntime(
  docker: Pick<DockerApiClient, "inspectContainer" | "inspectImage">,
  paths: AlloyRuntimePaths,
  input: AlloyRuntimeInput,
  fetchImpl: typeof fetch
): Promise<AlloyProbeResult> {
  const [inspection, image, configPresent] = await Promise.all([
    docker.inspectContainer(ALLOY_CONTAINER_NAME),
    docker.inspectImage(input.config.observability.alloyImage),
    access(paths.configPath, fsConstants.R_OK)
      .then(() => true)
      .catch(() => false),
  ]);

  let healthOk = false;
  if (inspection?.State?.Running) {
    try {
      const response = await fetchImpl(`http://${ALLOY_HTTP_HOST}:${ALLOY_HTTP_PORT}/metrics`);
      healthOk = response.ok;
    } catch {
      healthOk = false;
    }
  }

  return {
    configPresent,
    healthOk,
    imagePresent: image !== null,
    inspection,
  };
}

async function waitForAlloyHealth(
  docker: Pick<DockerApiClient, "inspectContainer" | "inspectImage">,
  input: AlloyRuntimeInput,
  paths: AlloyRuntimePaths,
  options: {
    fetchImpl: typeof fetch;
    timeoutMs: number;
    intervalMs: number;
  }
): Promise<void> {
  const startedAt = Date.now();
  let lastError = "Alloy runtime did not become healthy";

  while (Date.now() - startedAt < options.timeoutMs) {
    const probe = await probeAlloyRuntime(docker, paths, input, options.fetchImpl);

    if (!probe.inspection?.State?.Running) {
      lastError = "Alloy container is not running";
    } else if (!probe.configPresent) {
      lastError = "Alloy config file is missing";
    } else if (!probe.imagePresent) {
      lastError = "Alloy image is not present locally";
    } else if (!probe.healthOk) {
      lastError = `Alloy metrics endpoint is not reachable on ${ALLOY_HTTP_HOST}:${ALLOY_HTTP_PORT}`;
    } else {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
  }

  throw new Error(lastError);
}

function buildRelabelRules(input: AlloyRuntimeInput): string[] {
  const noneValue = quote(
    input.config.observability.noneLabelValue || OBSERVABILITY_NONE_LABEL_VALUE
  );
  const organizationId = quote(
    input.config.observability.organizationId ?? OBSERVABILITY_NONE_LABEL_VALUE
  );
  const serverId = quote(input.serverId);

  return [
    `  rule {
    source_labels = [${quote(OBSERVABILITY_DOCKER_LABELS.managed)}]
    action        = "keep"
    regex         = "true"
  }`,
    `  rule {
    source_labels = [${quote(OBSERVABILITY_DOCKER_LABELS.kind)}]
    action        = "keep"
    regex         = "app|database|traefik"
  }`,
    `  rule {
    target_label = "organization_id"
    replacement  = ${organizationId}
  }`,
    `  rule {
    target_label = "server_id"
    replacement  = ${serverId}
  }`,
    `  rule {
    target_label = "project_id"
    replacement  = ${noneValue}
  }`,
    `  rule {
    source_labels = [${quote(OBSERVABILITY_DOCKER_LABELS.projectId)}]
    target_label  = "project_id"
    regex         = "(.+)"
    replacement   = "$1"
  }`,
    `  rule {
    target_label = "service_id"
    replacement  = ${noneValue}
  }`,
    `  rule {
    source_labels = [${quote(OBSERVABILITY_DOCKER_LABELS.serviceId)}]
    target_label  = "service_id"
    regex         = "(.+)"
    replacement   = "$1"
  }`,
    `  rule {
    target_label = "deployment_id"
    replacement  = ${noneValue}
  }`,
    `  rule {
    source_labels = [${quote(OBSERVABILITY_DOCKER_LABELS.deploymentId)}]
    target_label  = "deployment_id"
    regex         = "(.+)"
    replacement   = "$1"
  }`,
    `  rule {
    target_label = "environment_id"
    replacement  = ${noneValue}
  }`,
    `  rule {
    source_labels = [${quote(OBSERVABILITY_DOCKER_LABELS.environmentId)}]
    target_label  = "environment_id"
    regex         = "(.+)"
    replacement   = "$1"
  }`,
    `  rule {
    target_label = "service_type"
    replacement  = "system"
  }`,
    `  rule {
    source_labels = [${quote(OBSERVABILITY_DOCKER_LABELS.kind)}]
    target_label  = "service_type"
    regex         = "app"
    replacement   = "app"
  }`,
    `  rule {
    source_labels = [${quote(OBSERVABILITY_DOCKER_LABELS.kind)}]
    target_label  = "service_type"
    regex         = "database"
    replacement   = "database"
  }`,
    `  rule {
    target_label = "service_variant"
    replacement  = ${noneValue}
  }`,
    `  rule {
    source_labels = [${quote(OBSERVABILITY_DOCKER_LABELS.kind)}]
    target_label  = "service_variant"
    regex         = "app"
    replacement   = "app"
  }`,
    `  rule {
    source_labels = [${quote(OBSERVABILITY_DOCKER_LABELS.kind)}]
    target_label  = "service_variant"
    regex         = "traefik"
    replacement   = "traefik"
  }`,
    `  rule {
    source_labels = [${quote(OBSERVABILITY_DOCKER_LABELS.serviceVariant)}]
    target_label  = "service_variant"
    regex         = "(.+)"
    replacement   = "$1"
  }`,
    `  rule {
    target_label = "container_name"
    replacement  = ${noneValue}
  }`,
    `  rule {
    source_labels = [${quote(OBSERVABILITY_DOCKER_LABELS.containerName)}]
    target_label  = "container_name"
    regex         = "/?(.*)"
    replacement   = "$1"
  }`,
    `  rule {
    target_label = "runtime_kind"
    replacement  = ${noneValue}
  }`,
    `  rule {
    source_labels = [${quote(OBSERVABILITY_DOCKER_LABELS.kind)}]
    target_label  = "runtime_kind"
    regex         = "(.+)"
    replacement   = "$1"
  }`,
  ];
}

export function getAlloyRuntimePaths(dataDir: string): AlloyRuntimePaths {
  const rootDir = path.join(dataDir, "alloy");
  return {
    rootDir,
    dataDir: path.join(rootDir, "data"),
    configPath: path.join(rootDir, "config.alloy"),
  };
}

export async function ensureAlloyState(paths: AlloyRuntimePaths): Promise<void> {
  await mkdir(paths.rootDir, { recursive: true });
  await mkdir(paths.dataDir, { recursive: true });
}

export function renderAlloyConfig(input: AlloyRuntimeInput): string {
  if (!input.config.observability.organizationId) {
    throw new Error("Alloy observability config requires an organization ID.");
  }

  const scrapeIntervalSeconds = Math.max(5, input.config.observability.scrapeIntervalSeconds || 30);
  const allowlistedLabels = list([
    "nouva.server.id",
    "nouva.project.id",
    "nouva.service.id",
    "nouva.deployment.id",
    "nouva.service.variant",
    "nouva.environment.id",
    "nouva.kind",
  ]);
  const dockerRules = buildRelabelRules(input);
  const noneValue = quote(
    input.config.observability.noneLabelValue || OBSERVABILITY_NONE_LABEL_VALUE
  );
  const organizationId = quote(input.config.observability.organizationId);
  const serverId = quote(input.serverId);

  return [
    `discovery.docker "nouva" {
  host = ${quote(`unix://${DOCKER_SOCKET}`)}
}`,
    `discovery.relabel "nouva_logs" {
  targets = discovery.docker.nouva.targets
${dockerRules.join("\n")}
}`,
    `loki.source.docker "nouva" {
  host       = ${quote(`unix://${DOCKER_SOCKET}`)}
  targets    = discovery.relabel.nouva_logs.output
  forward_to = [loki.write.nouva.receiver]
}`,
    `loki.write "nouva" {
  endpoint {
    url          = ${quote(`${input.apiUrl}/api/agent/observability/logs`)}
    bearer_token = ${quote(input.agentToken)}
  }
}`,
    `prometheus.exporter.cadvisor "nouva" {
  docker_host                  = ${quote(`unix://${DOCKER_SOCKET}`)}
  docker_only                  = true
  store_container_labels       = false
  disable_root_cgroup_stats    = true
  allowlisted_container_labels = ${allowlistedLabels}
}`,
    `prometheus.scrape "nouva_cadvisor" {
  targets         = prometheus.exporter.cadvisor.nouva.targets
  scrape_interval = ${quote(`${scrapeIntervalSeconds}s`)}
  forward_to      = [prometheus.relabel.nouva_cadvisor.receiver]
}`,
    `prometheus.relabel "nouva_cadvisor" {
  forward_to = [prometheus.remote_write.nouva.receiver]

  rule {
    source_labels = ["container_label_nouva_kind"]
    action        = "keep"
    regex         = "app|database|traefik"
  }

  rule {
    target_label = "organization_id"
    replacement  = ${organizationId}
  }

  rule {
    target_label = "server_id"
    replacement  = ${serverId}
  }

  rule {
    target_label = "project_id"
    replacement  = ${noneValue}
  }

  rule {
    source_labels = ["container_label_nouva_project_id"]
    target_label  = "project_id"
    regex         = "(.+)"
    replacement   = "$1"
  }

  rule {
    target_label = "service_id"
    replacement  = ${noneValue}
  }

  rule {
    source_labels = ["container_label_nouva_service_id"]
    target_label  = "service_id"
    regex         = "(.+)"
    replacement   = "$1"
  }

  rule {
    target_label = "deployment_id"
    replacement  = ${noneValue}
  }

  rule {
    source_labels = ["container_label_nouva_deployment_id"]
    target_label  = "deployment_id"
    regex         = "(.+)"
    replacement   = "$1"
  }

  rule {
    target_label = "environment_id"
    replacement  = ${noneValue}
  }

  rule {
    source_labels = ["container_label_nouva_environment_id"]
    target_label  = "environment_id"
    regex         = "(.+)"
    replacement   = "$1"
  }

  rule {
    target_label = "service_type"
    replacement  = "system"
  }

  rule {
    source_labels = ["container_label_nouva_kind"]
    target_label  = "service_type"
    regex         = "app"
    replacement   = "app"
  }

  rule {
    source_labels = ["container_label_nouva_kind"]
    target_label  = "service_type"
    regex         = "database"
    replacement   = "database"
  }

  rule {
    target_label = "service_variant"
    replacement  = ${noneValue}
  }

  rule {
    source_labels = ["container_label_nouva_kind"]
    target_label  = "service_variant"
    regex         = "app"
    replacement   = "app"
  }

  rule {
    source_labels = ["container_label_nouva_kind"]
    target_label  = "service_variant"
    regex         = "traefik"
    replacement   = "traefik"
  }

  rule {
    source_labels = ["container_label_nouva_service_variant"]
    target_label  = "service_variant"
    regex         = "(.+)"
    replacement   = "$1"
  }

  rule {
    target_label = "container_name"
    replacement  = ${noneValue}
  }

  rule {
    source_labels = ["name"]
    target_label  = "container_name"
    regex         = "/?(.*)"
    replacement   = "$1"
  }

  rule {
    target_label = "runtime_kind"
    replacement  = ${noneValue}
  }

  rule {
    source_labels = ["container_label_nouva_kind"]
    target_label  = "runtime_kind"
    regex         = "(.+)"
    replacement   = "$1"
  }

  rule {
    action = "labeldrop"
    regex  = "container_label_.*|instance|job|id|name|image|container"
  }
}`,
    `prometheus.exporter.unix "nouva" {
  rootfs_path = ${quote("/rootfs")}
  procfs_path = ${quote("/rootfs/proc")}
  sysfs_path  = ${quote("/rootfs/sys")}
}`,
    `prometheus.scrape "nouva_host" {
  targets         = prometheus.exporter.unix.nouva.targets
  scrape_interval = ${quote(`${scrapeIntervalSeconds}s`)}
  forward_to      = [prometheus.relabel.nouva_host.receiver]
}`,
    `prometheus.relabel "nouva_host" {
  forward_to = [prometheus.remote_write.nouva.receiver]

  rule {
    target_label = "organization_id"
    replacement  = ${organizationId}
  }

  rule {
    target_label = "server_id"
    replacement  = ${serverId}
  }

  rule {
    target_label = "project_id"
    replacement  = ${noneValue}
  }

  rule {
    target_label = "service_id"
    replacement  = ${noneValue}
  }

  rule {
    target_label = "deployment_id"
    replacement  = ${noneValue}
  }

  rule {
    target_label = "service_type"
    replacement  = "system"
  }

  rule {
    target_label = "service_variant"
    replacement  = "host"
  }

  rule {
    target_label = "environment_id"
    replacement  = ${noneValue}
  }

  rule {
    target_label = "container_name"
    replacement  = "host"
  }

  rule {
    target_label = "runtime_kind"
    replacement  = "host"
  }

  rule {
    action = "labeldrop"
    regex  = "instance|job"
  }
}`,
    `prometheus.remote_write "nouva" {
  endpoint {
    url          = ${quote(`${input.apiUrl}/api/agent/observability/metrics`)}
    bearer_token = ${quote(input.agentToken)}
  }
}`,
    "",
  ].join("\n\n");
}

export function createAlloyStateHash(configContents: string): string {
  return createHash("sha256").update(configContents).digest("hex");
}

export function buildAlloyContainerSpec(
  input: AlloyRuntimeInput,
  options: {
    stateHash: string;
    labels?: Record<string, string>;
  }
): DockerContainerSpec {
  return {
    name: ALLOY_CONTAINER_NAME,
    image: input.config.observability.alloyImage,
    cmd: [
      "run",
      `--server.http.listen-addr=0.0.0.0:${ALLOY_HTTP_PORT}`,
      `--storage.path=${ALLOY_DATA_DIR_IN_CONTAINER}`,
      ALLOY_CONFIG_PATH_IN_CONTAINER,
    ],
    labels: {
      "nouva.managed": "true",
      "nouva.kind": "observability",
      "nouva.server.id": input.serverId,
      [ALLOY_ROLE_LABEL]: "collector",
      [ALLOY_CONFIG_HASH_LABEL]: options.stateHash,
      ...(options.labels ?? {}),
    },
    exposedPorts: {
      [`${ALLOY_HTTP_PORT}/tcp`]: {},
    },
    hostConfig: {
      PortBindings: {
        [`${ALLOY_HTTP_PORT}/tcp`]: [
          {
            HostIp: ALLOY_HTTP_HOST,
            HostPort: String(ALLOY_HTTP_PORT),
          },
        ],
      },
      Binds: [
        `${DOCKER_SOCKET}:${DOCKER_SOCKET}`,
        `/:/rootfs:ro`,
        `/sys:/sys:ro`,
        `/var/run:/var/run:ro`,
        `/var/lib/docker:/var/lib/docker:ro`,
        `${input.dataVolume}:${AGENT_DATA_DIR_IN_CONTAINER}`,
      ],
      RestartPolicy: {
        Name: "unless-stopped",
      },
      Privileged: true,
    },
  };
}

export async function reconcileAlloyRuntime(
  docker: Pick<
    DockerApiClient,
    "ensureContainer" | "inspectContainer" | "removeContainer" | "inspectImage"
  >,
  input: AlloyRuntimeInput,
  options: ReconcileAlloyRuntimeOptions = {}
): Promise<void> {
  if (!input.config.observability.enabled) {
    return;
  }

  if (!input.config.observability.organizationId) {
    throw new Error("Alloy runtime requires an organization ID.");
  }

  const paths = options.paths ?? getAlloyRuntimePaths(input.dataDir);
  await ensureAlloyState(paths);

  const configContents = renderAlloyConfig(input);
  await writeManagedFile(paths.configPath, configContents);

  const stateHash = createAlloyStateHash(configContents);
  const inspection = await docker.inspectContainer(ALLOY_CONTAINER_NAME);
  if (isAlloyContainerCurrent(inspection, input, stateHash)) {
    lastAlloyRuntimeFailure = null;
    return;
  }

  if (inspection) {
    await docker.removeContainer(ALLOY_CONTAINER_NAME, true);
  }

  await docker.ensureContainer(buildAlloyContainerSpec(input, { stateHash }));
  await waitForAlloyHealth(docker, input, paths, {
    fetchImpl: options.fetchImpl ?? fetch,
    timeoutMs: options.timeoutMs ?? 30_000,
    intervalMs: options.intervalMs ?? 500,
  });
  lastAlloyRuntimeFailure = null;
}

export async function ensureAlloyRuntime(
  docker: Pick<
    DockerApiClient,
    "ensureContainer" | "inspectContainer" | "removeContainer" | "inspectImage"
  >,
  input: AlloyRuntimeInput,
  deps: AlloyRuntimeDeps = {}
): Promise<void> {
  try {
    await reconcileAlloyRuntime(docker, input, deps);
  } catch (error) {
    lastAlloyRuntimeFailure = error instanceof Error ? error : new Error("Alloy reconcile failed");
    throw lastAlloyRuntimeFailure;
  }
}

export async function collectAlloyValidationChecks(
  docker: Pick<DockerApiClient, "inspectContainer" | "inspectImage">,
  input: AlloyRuntimeInput,
  options: CollectAlloyValidationChecksOptions = {},
  bootstrapError?: Error | null
): Promise<ServerValidationCheck[]> {
  const paths = options.paths ?? getAlloyRuntimePaths(input.dataDir);
  const probe = await probeAlloyRuntime(docker, paths, input, options.fetchImpl ?? fetch);
  const checks: ServerValidationCheck[] = [];

  checks.push(
    buildCheck(
      "alloy-image",
      "Alloy image",
      probe.imagePresent ? "pass" : "fail",
      probe.imagePresent
        ? `Alloy image ${input.config.observability.alloyImage} is present locally`
        : `Expected ${input.config.observability.alloyImage}`,
      input.config.observability.alloyImage
    )
  );

  const containerStatus: ServerCheckStatus =
    probe.inspection?.State?.Running === true
      ? lastAlloyRuntimeFailure || bootstrapError
        ? "warn"
        : "pass"
      : "fail";
  const containerMessage =
    probe.inspection?.State?.Running === true
      ? lastAlloyRuntimeFailure
        ? `Alloy is running but the last reconcile failed: ${lastAlloyRuntimeFailure.message}`
        : bootstrapError
          ? `Alloy is running but reconcile failed: ${bootstrapError.message}`
          : "Alloy container is running"
      : "Alloy container is not running";

  checks.push(
    buildCheck(
      "alloy-container",
      "Alloy container",
      containerStatus,
      containerMessage,
      probe.inspection?.Name ?? null
    )
  );

  checks.push(
    buildCheck(
      "alloy-config",
      "Alloy config",
      probe.configPresent ? "pass" : "fail",
      probe.configPresent ? "Alloy config file is present" : "Alloy config file is missing",
      paths.configPath
    )
  );

  checks.push(
    buildCheck(
      "alloy-health",
      "Alloy health",
      probe.healthOk ? "pass" : "fail",
      probe.healthOk
        ? `Alloy metrics endpoint responds on ${ALLOY_HTTP_HOST}:${ALLOY_HTTP_PORT}`
        : `Alloy metrics endpoint is not reachable on ${ALLOY_HTTP_HOST}:${ALLOY_HTTP_PORT}`,
      `${ALLOY_HTTP_HOST}:${ALLOY_HTTP_PORT}`
    )
  );

  checks.push(
    buildCheck(
      "alloy-mounts",
      "Alloy mounts",
      hasRequiredBinds(probe.inspection) ? "pass" : "fail",
      hasRequiredBinds(probe.inspection)
        ? "Alloy container has the required host mounts"
        : "Alloy container is missing one or more required host mounts"
    )
  );

  return checks;
}

export function buildUnavailableAlloyChecks(reason: string): ServerValidationCheck[] {
  return [
    buildCheck("alloy-image", "Alloy image", "fail", reason),
    buildCheck("alloy-container", "Alloy container", "fail", reason),
    buildCheck("alloy-config", "Alloy config", "fail", reason),
    buildCheck(
      "alloy-health",
      "Alloy health",
      "fail",
      reason,
      `${ALLOY_HTTP_HOST}:${ALLOY_HTTP_PORT}`
    ),
    buildCheck("alloy-mounts", "Alloy mounts", "fail", reason),
  ];
}

export function resetAlloyRuntimeState(): void {
  lastAlloyRuntimeFailure = null;
}
