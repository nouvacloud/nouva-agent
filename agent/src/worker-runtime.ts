import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { hashProjectNetwork } from "./build.js";
import type {
  DockerApiClient,
  DockerContainerInspection,
  DockerContainerSpec,
  DockerImageInspection,
} from "./docker-api.js";
import { toDockerResourceSettings } from "./docker-resource-limits.js";
import type {
  AgentImageStoreMode,
  AppVolumeIdentity,
  RuntimeMetadata,
  RuntimeRetainedImage,
  WorkerDeployOnlyPayload,
  WorkerJobLifecyclePayload,
  WorkerJobPayload,
} from "./protocol.js";

const WORKER_VOLUME_SNAPSHOT_IMAGE = "alpine:3.21";
const WORKER_HEALTHCHECK_INTERVAL_NS = 10_000_000_000;
const WORKER_HEALTHCHECK_TIMEOUT_NS = 5_000_000_000;
const WORKER_HEALTHCHECK_START_PERIOD_NS = 10_000_000_000;

export const DEFAULT_WORKER_READINESS_TIMEOUT_MS = 60_000;
export const DEFAULT_WORKER_READINESS_INTERVAL_MS = 500;
export const DEFAULT_WORKER_RUNNING_GRACE_MS = 10_000;
export const DEFAULT_WORKER_CRASH_LOOP_RESTART_COUNT = 3;

type WorkerRuntimeDocker = Pick<
  DockerApiClient,
  | "containerLogs"
  | "createContainer"
  | "createVolume"
  | "ensureContainer"
  | "ensureNetwork"
  | "inspectContainer"
  | "inspectImage"
  | "listContainersByLabels"
  | "listContainersUsingVolume"
  | "pullImage"
  | "removeContainer"
  | "removeImage"
  | "restartContainer"
  | "startContainer"
  | "stopContainer"
  | "waitContainer"
>;

export interface WorkerRuntimeEnvironment {
  serverId: string;
  imageStoreMode: AgentImageStoreMode;
  dataDir: string;
  dataVolume: string;
}

export interface WorkerImageCommand {
  entrypoint: string[];
  command: string[];
  display: string;
}

export interface WorkerRuntimeInstance {
  kind: "worker";
  status: "running";
  replicaIndex: number;
  name: string;
  image: string;
  containerId: string;
  containerName: string;
  networkName: string;
  internalHost: string;
}

export interface WorkerRolloutResult {
  strategy: "candidate_ready_cutover" | "single_writer_snapshot_cutover";
  outcome: "committed" | "aborted_before_cutover" | "rolled_back";
  currentPhase: "candidate" | "ready" | "retire" | "restore";
  liveRuntimePreserved: boolean;
  rollbackCompleted: boolean;
  activeContainerNames: string[];
  candidateContainerNames: string[];
}

export class WorkerRolloutError extends Error {
  readonly result: Record<string, unknown>;

  constructor(message: string, rollout: WorkerRolloutResult) {
    super(message);
    this.name = "WorkerRolloutError";
    this.result = { rollout };
  }
}

interface WorkerJobReceipt {
  version: 1;
  projectId: string;
  serviceId: string;
  deploymentId: string;
  scheduleRunId: string;
  scheduleId: string;
  occurrenceKey: string;
  jobName: string;
  imageUrl: string;
  containerId: string;
  containerName: string;
  status: "created" | "running" | "succeeded" | "failed" | "cancelled" | "missing";
  exitCode: number | null;
  createdAt: string;
  completedAt: string | null;
}

function normalizeCommandParts(parts: string[] | null | undefined): string[] {
  return (parts ?? []).map((part) => part.trim()).filter((part) => part.length > 0);
}

function normalizeWorkerCommand(command: string | null | undefined): string | null {
  const normalized = command?.trim();
  return normalized ? normalized : null;
}

function getWorkerProjectNetwork(projectId: string): string {
  return `nouva-project-${hashProjectNetwork(projectId)}`;
}

function getContainerName(container: DockerContainerInspection): string {
  return container.Name.replace(/^\//, "");
}

function getContainerIdentifier(container: DockerContainerInspection): string {
  return container.Id || getContainerName(container);
}

function buildWorkerLabels(input: {
  serverId: string;
  kind: "worker" | "worker_job" | "worker_volume_task";
  projectId: string;
  environmentId?: string | null;
  serviceId: string;
  deploymentId?: string | null;
  replicaIndex?: number;
  scheduleId?: string;
  scheduleRunId?: string;
  occurrenceKey?: string;
}): Record<string, string> {
  return {
    "nouva.managed": "true",
    "nouva.server.id": input.serverId,
    "nouva.kind": input.kind,
    "nouva.service.type": "worker",
    "nouva.project.id": input.projectId,
    "nouva.service.id": input.serviceId,
    ...(input.environmentId ? { "nouva.environment.id": input.environmentId } : {}),
    ...(input.deploymentId ? { "nouva.deployment.id": input.deploymentId } : {}),
    ...(typeof input.replicaIndex === "number"
      ? { "nouva.replica.index": String(input.replicaIndex) }
      : {}),
    ...(input.scheduleId ? { "nouva.schedule.id": input.scheduleId } : {}),
    ...(input.scheduleRunId ? { "nouva.schedule.run.id": input.scheduleRunId } : {}),
    ...(input.occurrenceKey ? { "nouva.schedule.occurrence.key": input.occurrenceKey } : {}),
  };
}

export function buildWorkerReplicaContainerName(
  serviceId: string,
  deploymentId: string,
  replicaIndex: number
): string {
  return `nouva-worker-${serviceId.slice(0, 8)}-${deploymentId.slice(0, 8)}-${replicaIndex}`;
}

export function buildWorkerJobContainerName(serviceId: string, scheduleRunId: string): string {
  return `nouva-worker-job-${serviceId.slice(0, 8)}-${scheduleRunId.slice(0, 8)}`;
}

export function detectWorkerImageCommand(
  inspection: DockerImageInspection | null
): WorkerImageCommand | null {
  const entrypoint = normalizeCommandParts(inspection?.Config?.Entrypoint);
  const command = normalizeCommandParts(inspection?.Config?.Cmd);
  if (entrypoint.length === 0 && command.length === 0) {
    return null;
  }

  return {
    entrypoint,
    command,
    display: [...entrypoint, ...command].join(" "),
  };
}

function imageHasHealthcheck(inspection: DockerImageInspection | null): boolean {
  const test = inspection?.Config?.Healthcheck?.Test;
  return Array.isArray(test) && test.length > 0 && test[0]?.toUpperCase() !== "NONE";
}

export function buildWorkerHealthcheck(
  command: string | null | undefined
): DockerContainerSpec["healthcheck"] {
  const normalizedCommand = normalizeWorkerCommand(command);
  if (!normalizedCommand) {
    return undefined;
  }

  return {
    Test: ["CMD-SHELL", normalizedCommand],
    Interval: WORKER_HEALTHCHECK_INTERVAL_NS,
    Timeout: WORKER_HEALTHCHECK_TIMEOUT_NS,
    Retries: 3,
    StartPeriod: WORKER_HEALTHCHECK_START_PERIOD_NS,
  };
}

export function buildWorkerContainerSpec(input: {
  environment: Pick<WorkerRuntimeEnvironment, "serverId">;
  payload: WorkerDeployOnlyPayload;
  image: DockerImageInspection | null;
  replicaIndex: number;
}): {
  containerName: string;
  projectNetwork: string;
  hasHealthcheck: boolean;
  imageCommand: WorkerImageCommand | null;
  spec: DockerContainerSpec;
} {
  const { payload } = input;
  const containerName = buildWorkerReplicaContainerName(
    payload.serviceId,
    payload.deploymentId,
    input.replicaIndex
  );
  const projectNetwork = getWorkerProjectNetwork(payload.projectId);
  const startCommand = normalizeWorkerCommand(payload.startCommand);
  const imageCommand = detectWorkerImageCommand(input.image);
  if (!startCommand && !imageCommand) {
    throw new Error(
      `Worker image ${payload.imageUrl} has no runnable default entrypoint or command. ` +
        "Set a worker start command or rebuild the image with a CMD or ENTRYPOINT."
    );
  }

  const healthcheck = buildWorkerHealthcheck(payload.healthCheckCommand);
  return {
    containerName,
    projectNetwork,
    hasHealthcheck: Boolean(healthcheck) || imageHasHealthcheck(input.image),
    imageCommand,
    spec: {
      name: containerName,
      image: payload.imageUrl,
      env: Object.entries(payload.envVars).map(([key, value]) => `${key}=${value}`),
      ...(startCommand
        ? {
            entrypoint: ["/bin/sh", "-lc"],
            cmd: [startCommand],
          }
        : {}),
      labels: buildWorkerLabels({
        serverId: input.environment.serverId,
        kind: "worker",
        projectId: payload.projectId,
        environmentId: payload.environmentId ?? null,
        serviceId: payload.serviceId,
        deploymentId: payload.deploymentId,
        replicaIndex: input.replicaIndex,
      }),
      ...(healthcheck ? { healthcheck } : {}),
      hostConfig: {
        ...(payload.volume
          ? {
              Mounts: [
                {
                  Type: "volume",
                  Source: payload.volume.volumeName,
                  Target: payload.volume.mountPath,
                },
              ],
            }
          : {}),
        RestartPolicy: {
          Name: "unless-stopped",
        },
        ...toDockerResourceSettings(payload.resourceLimits),
      },
      networkingConfig: {
        EndpointsConfig: {
          [projectNetwork]: {},
        },
      },
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTerminalContainerStatus(status: string | undefined): boolean {
  return status === "dead" || status === "exited" || status === "removing";
}

export async function waitForWorkerReadiness(
  docker: Pick<DockerApiClient, "inspectContainer">,
  input: {
    containerName: string;
    hasHealthcheck: boolean;
    timeoutMs?: number;
    intervalMs?: number;
    runningGraceMs?: number;
    crashLoopRestartCount?: number;
    now?: () => number;
    wait?: (ms: number) => Promise<void>;
  }
): Promise<void> {
  const now = input.now ?? Date.now;
  const timeoutMs = input.timeoutMs ?? DEFAULT_WORKER_READINESS_TIMEOUT_MS;
  const intervalMs = input.intervalMs ?? DEFAULT_WORKER_READINESS_INTERVAL_MS;
  const runningGraceMs = input.runningGraceMs ?? DEFAULT_WORKER_RUNNING_GRACE_MS;
  const crashLoopRestartCount =
    input.crashLoopRestartCount ?? DEFAULT_WORKER_CRASH_LOOP_RESTART_COUNT;
  const deadline = now() + timeoutMs;
  let runningSince: number | null = null;
  let observedRestartCount: number | null = null;

  while (now() <= deadline) {
    const inspection = await docker.inspectContainer(input.containerName);
    if (!inspection) {
      throw new Error(`Worker candidate ${input.containerName} is missing`);
    }

    const status = inspection.State?.Status?.toLowerCase();
    if (isTerminalContainerStatus(status)) {
      throw new Error(`Worker candidate ${input.containerName} is not running (${status})`);
    }

    const restartCount = inspection.RestartCount ?? 0;
    if (restartCount >= crashLoopRestartCount) {
      throw new Error(
        `Worker candidate ${input.containerName} is crash-looping (${restartCount} restarts)`
      );
    }
    if (observedRestartCount !== null && restartCount > observedRestartCount) {
      runningSince = null;
    }
    observedRestartCount = restartCount;

    const healthStatus = inspection.State?.Health?.Status?.toLowerCase();
    if (healthStatus === "unhealthy") {
      throw new Error(`Worker candidate ${input.containerName} became unhealthy`);
    }

    if (input.hasHealthcheck) {
      if (healthStatus === "healthy") {
        return;
      }
    } else if (inspection.State?.Running) {
      runningSince ??= now();
      if (now() - runningSince >= runningGraceMs) {
        return;
      }
    } else {
      runningSince = null;
    }

    await (input.wait ?? sleep)(intervalMs);
  }

  if (input.hasHealthcheck) {
    throw new Error(
      `Worker candidate ${input.containerName} did not become healthy within ${timeoutMs}ms`
    );
  }
  throw new Error(
    `Worker candidate ${input.containerName} did not remain running for ${runningGraceMs}ms`
  );
}

function resolveCurrentRuntimeImage(
  runtimeMetadata: RuntimeMetadata | null | undefined
): RuntimeRetainedImage | null {
  if (runtimeMetadata?.currentImage) {
    return runtimeMetadata.currentImage;
  }
  if (runtimeMetadata?.image) {
    return {
      reference: runtimeMetadata.image,
      imageId: null,
      deploymentId: null,
      commitHash: null,
    };
  }
  return null;
}

function resolvePreviousRuntimeImage(
  runtimeMetadata: RuntimeMetadata | null | undefined
): RuntimeRetainedImage | null {
  return runtimeMetadata?.previousImage ?? null;
}

function sameRetainedImage(
  left: RuntimeRetainedImage | null,
  right: RuntimeRetainedImage | null
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return left.imageId && right.imageId
    ? left.imageId === right.imageId
    : left.reference === right.reference;
}

function getRetainedImageReferences(runtimeMetadata: RuntimeMetadata | null | undefined): string[] {
  return [resolveCurrentRuntimeImage(runtimeMetadata), resolvePreviousRuntimeImage(runtimeMetadata)]
    .map((image) => image?.reference || image?.imageId || null)
    .filter((reference): reference is string => Boolean(reference))
    .filter((reference, index, references) => references.indexOf(reference) === index);
}

function shouldRetainWorkerImage(
  runtimeMetadata: RuntimeMetadata | null | undefined,
  reference: string
): boolean {
  return getRetainedImageReferences(runtimeMetadata).includes(reference);
}

async function ensureWorkerImage(
  docker: Pick<DockerApiClient, "inspectImage" | "pullImage">,
  environment: Pick<WorkerRuntimeEnvironment, "imageStoreMode">,
  imageUrl: string
): Promise<DockerImageInspection> {
  let inspection = await docker.inspectImage(imageUrl);
  if (!inspection && environment.imageStoreMode !== "docker-local") {
    await docker.pullImage(imageUrl);
    inspection = await docker.inspectImage(imageUrl);
  }
  if (!inspection) {
    throw new Error(`Worker image ${imageUrl} is not available locally`);
  }
  return inspection;
}

async function listWorkerServiceContainers(
  docker: Pick<DockerApiClient, "listContainersByLabels">,
  serviceId: string
): Promise<DockerContainerInspection[]> {
  const containers = await docker.listContainersByLabels({
    "nouva.managed": "true",
    "nouva.kind": "worker",
    "nouva.service.id": serviceId,
  });
  const seen = new Set<string>();
  return containers.filter((container) => {
    const identifier = getContainerIdentifier(container);
    if (seen.has(identifier)) {
      return false;
    }
    seen.add(identifier);
    return true;
  });
}

async function listWorkerManagedContainers(
  docker: Pick<DockerApiClient, "listContainersByLabels">,
  serviceId: string
): Promise<DockerContainerInspection[]> {
  const containers = await docker.listContainersByLabels({
    "nouva.managed": "true",
    "nouva.service.id": serviceId,
  });
  const seen = new Set<string>();
  return containers.filter((container) => {
    const kind = container.Config?.Labels?.["nouva.kind"];
    if (kind !== "worker" && kind !== "worker_job" && kind !== "worker_volume_task") {
      return false;
    }
    const identifier = getContainerIdentifier(container);
    if (seen.has(identifier)) {
      return false;
    }
    seen.add(identifier);
    return true;
  });
}

function assertReplicaCount(replicaCount: number): void {
  if (!Number.isInteger(replicaCount) || replicaCount < 0 || replicaCount > 32) {
    throw new Error("Worker replicaCount must be an integer from 0 through 32");
  }
}

function assertWorkerJobTimeout(timeoutSeconds: number): void {
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 60 || timeoutSeconds > 24 * 60 * 60) {
    throw new Error("Worker job timeoutSeconds must be an integer from 60 through 86400");
  }
}

function assertVolumeWorkerPayload(payload: WorkerDeployOnlyPayload): void {
  if (payload.volume && payload.replicaCount > 1) {
    throw new Error("Volume-backed workers support at most one continuous replica");
  }
}

async function assertNoUnexpectedVolumeConsumer(
  docker: Pick<DockerApiClient, "listContainersUsingVolume">,
  volumeName: string,
  allowedNames: Set<string>
): Promise<void> {
  const consumers = await docker.listContainersUsingVolume(volumeName);
  const unexpected = consumers.filter(
    (container) => container.State?.Running && !allowedNames.has(getContainerName(container))
  );
  if (unexpected.length > 0) {
    throw new Error(`Volume ${volumeName} has another running consumer`);
  }
}

function buildWorkerVolumeSnapshotName(payload: WorkerDeployOnlyPayload): string {
  return `${payload.serviceId}-${payload.deploymentId}.tar.gz`;
}

async function runWorkerVolumeTask(
  docker: Pick<
    DockerApiClient,
    | "containerLogs"
    | "createContainer"
    | "pullImage"
    | "removeContainer"
    | "startContainer"
    | "waitContainer"
  >,
  environment: Pick<WorkerRuntimeEnvironment, "serverId" | "dataVolume">,
  input: {
    name: string;
    projectId: string;
    serviceId: string;
    command: string;
    mounts: Array<{ source: string; target: string; readOnly?: boolean }>;
  }
): Promise<void> {
  await docker.pullImage(WORKER_VOLUME_SNAPSHOT_IMAGE);
  await docker.removeContainer(input.name, true);
  const id = await docker.createContainer({
    name: input.name,
    image: WORKER_VOLUME_SNAPSHOT_IMAGE,
    entrypoint: ["/bin/sh", "-ec"],
    cmd: [input.command],
    tty: true,
    labels: buildWorkerLabels({
      serverId: environment.serverId,
      kind: "worker_volume_task",
      projectId: input.projectId,
      serviceId: input.serviceId,
    }),
    hostConfig: {
      AutoRemove: false,
      Mounts: input.mounts.map((mount) => ({
        Type: "volume",
        Source: mount.source,
        Target: mount.target,
        ReadOnly: mount.readOnly === true,
      })),
    },
  });

  try {
    await docker.startContainer(id);
    const status = await docker.waitContainer(id);
    if (status !== 0) {
      const logs = await docker.containerLogs(id).catch(() => "");
      throw new Error(logs.trim() || `Worker volume task ${input.name} failed (${status})`);
    }
  } finally {
    await docker.removeContainer(id, true);
  }
}

async function createWorkerVolumeSnapshot(
  docker: WorkerRuntimeDocker,
  environment: WorkerRuntimeEnvironment,
  payload: WorkerDeployOnlyPayload
): Promise<string> {
  if (!payload.volume) {
    throw new Error("Worker volume snapshot requires a volume");
  }
  const snapshotName = buildWorkerVolumeSnapshotName(payload);
  await docker.createVolume(environment.dataVolume);
  await runWorkerVolumeTask(docker, environment, {
    name: `nouva-worker-snapshot-${payload.deploymentId.slice(0, 12)}`,
    projectId: payload.projectId,
    serviceId: payload.serviceId,
    command: [
      "mkdir -p /agent-data/worker-volume-snapshots",
      `final=/agent-data/worker-volume-snapshots/${snapshotName}`,
      'if [ -s "$final" ]; then exit 0; fi',
      "required=$(du -sk /source | awk '{print $1}')",
      "available=$(df -Pk /agent-data | awk 'NR==2 {print $4}')",
      'if [ "$available" -le "$required" ]; then echo "Insufficient snapshot capacity" >&2; exit 1; fi',
      'tmp="$final.tmp"',
      'rm -f "$tmp"',
      'tar -C /source -czpf "$tmp" .',
      'test -s "$tmp"',
      'mv "$tmp" "$final"',
    ].join("\n"),
    mounts: [
      { source: payload.volume.volumeName, target: "/source", readOnly: true },
      { source: environment.dataVolume, target: "/agent-data" },
    ],
  });
  return snapshotName;
}

async function restoreWorkerVolumeSnapshot(
  docker: WorkerRuntimeDocker,
  environment: WorkerRuntimeEnvironment,
  payload: WorkerDeployOnlyPayload,
  snapshotName: string
): Promise<void> {
  if (!payload.volume) {
    throw new Error("Worker volume restore requires a volume");
  }
  await runWorkerVolumeTask(docker, environment, {
    name: `nouva-worker-restore-${payload.deploymentId.slice(0, 12)}`,
    projectId: payload.projectId,
    serviceId: payload.serviceId,
    command: [
      `archive=/agent-data/worker-volume-snapshots/${snapshotName}`,
      'test -s "$archive"',
      "find /target -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +",
      'tar -C /target -xzpf "$archive"',
    ].join("\n"),
    mounts: [
      { source: payload.volume.volumeName, target: "/target" },
      { source: environment.dataVolume, target: "/agent-data", readOnly: true },
    ],
  });
}

async function deleteWorkerVolumeSnapshotBestEffort(
  docker: WorkerRuntimeDocker,
  environment: WorkerRuntimeEnvironment,
  payload: WorkerDeployOnlyPayload,
  snapshotName: string
): Promise<void> {
  try {
    await runWorkerVolumeTask(docker, environment, {
      name: `nouva-worker-snapshot-cleanup-${payload.deploymentId.slice(0, 12)}`,
      projectId: payload.projectId,
      serviceId: payload.serviceId,
      command: `rm -f /agent-data/worker-volume-snapshots/${snapshotName}`,
      mounts: [{ source: environment.dataVolume, target: "/agent-data" }],
    });
  } catch (error) {
    console.warn(`Failed to clean worker volume snapshot ${snapshotName}`, error);
  }
}

async function restorePreviousWorkerVolumeRuntime(
  docker: WorkerRuntimeDocker,
  previousContainers: DockerContainerInspection[]
): Promise<boolean> {
  try {
    for (const container of previousContainers) {
      await docker.startContainer(getContainerIdentifier(container));
      await waitForWorkerReadiness(docker, {
        containerName: getContainerName(container),
        hasHealthcheck: false,
      });
    }
    return previousContainers.length > 0;
  } catch {
    return false;
  }
}

async function removeExistingWorkerCandidates(
  docker: Pick<DockerApiClient, "inspectContainer" | "removeContainer">,
  candidates: DockerContainerInspection[]
): Promise<void> {
  for (const candidate of candidates) {
    await docker.removeContainer(getContainerIdentifier(candidate), true);
  }

  for (const candidate of candidates) {
    const identifier = getContainerIdentifier(candidate);
    if (await docker.inspectContainer(identifier)) {
      throw new Error(`Worker candidate ${identifier} still exists after retry recovery`);
    }
  }
}

async function restorePreviousWorkerVolumeRuntimeIfSafe(
  docker: WorkerRuntimeDocker,
  volumeName: string,
  previousContainers: DockerContainerInspection[]
): Promise<boolean> {
  try {
    await assertNoUnexpectedVolumeConsumer(docker, volumeName, new Set());
  } catch {
    return false;
  }

  return await restorePreviousWorkerVolumeRuntime(docker, previousContainers);
}

function buildWorkerRolloutResult(input: {
  strategy: WorkerRolloutResult["strategy"];
  outcome: WorkerRolloutResult["outcome"];
  currentPhase: WorkerRolloutResult["currentPhase"];
  liveRuntimePreserved: boolean;
  rollbackCompleted: boolean;
  activeContainerNames: string[];
  candidateContainerNames: string[];
}): WorkerRolloutResult {
  return input;
}

export async function deployWorkerRuntime(
  docker: WorkerRuntimeDocker,
  environment: WorkerRuntimeEnvironment,
  payload: WorkerDeployOnlyPayload
): Promise<Record<string, unknown>> {
  assertReplicaCount(payload.replicaCount);
  assertVolumeWorkerPayload(payload);

  const projectNetwork = getWorkerProjectNetwork(payload.projectId);
  await docker.ensureNetwork(projectNetwork, {
    "nouva.managed": "true",
    "nouva.server.id": environment.serverId,
    "nouva.project.id": payload.projectId,
  });
  if (payload.volume) {
    await docker.createVolume(payload.volume.volumeName, {
      "nouva.managed": "true",
      "nouva.server.id": environment.serverId,
      "nouva.volume.id": payload.volume.volumeId,
      "nouva.project.id": payload.projectId,
      "nouva.service.id": payload.serviceId,
    });
  }

  const image =
    payload.replicaCount > 0
      ? await ensureWorkerImage(docker, environment, payload.imageUrl)
      : await docker.inspectImage(payload.imageUrl);
  const candidateSpecs = Array.from({ length: payload.replicaCount }, (_, replicaIndex) =>
    buildWorkerContainerSpec({
      environment,
      payload,
      image,
      replicaIndex,
    })
  );
  const candidateNames = candidateSpecs.map((candidate) => candidate.containerName);
  const candidateNameSet = new Set(candidateNames);
  const currentContainers = await listWorkerServiceContainers(docker, payload.serviceId);
  const existingCandidateContainers = currentContainers.filter((container) =>
    candidateNameSet.has(getContainerName(container))
  );
  const previousContainers = currentContainers.filter(
    (container) => !candidateNameSet.has(getContainerName(container))
  );
  if (payload.volume) {
    await assertNoUnexpectedVolumeConsumer(
      docker,
      payload.volume.volumeName,
      new Set(currentContainers.map(getContainerName))
    );
  }
  const isVolumeCutover = Boolean(
    payload.volume && payload.replicaCount > 0 && previousContainers.length > 0
  );
  let snapshotName: string | null = null;

  if (isVolumeCutover && payload.volume) {
    const previousNames = new Set(previousContainers.map(getContainerName));
    try {
      // A retry can find a candidate that a prior agent process started before
      // it could retire the old writer. Reset that incomplete cutover first so
      // restoring the previous runtime can never create two volume writers.
      await removeExistingWorkerCandidates(docker, existingCandidateContainers);
      await assertNoUnexpectedVolumeConsumer(docker, payload.volume.volumeName, previousNames);
      for (const container of previousContainers) {
        await docker.stopContainer(getContainerIdentifier(container));
      }
      await assertNoUnexpectedVolumeConsumer(docker, payload.volume.volumeName, new Set());
      snapshotName = await createWorkerVolumeSnapshot(docker, environment, payload);
    } catch (error) {
      const liveRuntimePreserved = await restorePreviousWorkerVolumeRuntimeIfSafe(
        docker,
        payload.volume.volumeName,
        previousContainers
      );
      throw new WorkerRolloutError(
        error instanceof Error ? error.message : "Worker volume snapshot failed",
        buildWorkerRolloutResult({
          strategy: "single_writer_snapshot_cutover",
          outcome: "aborted_before_cutover",
          currentPhase: "restore",
          liveRuntimePreserved,
          rollbackCompleted: false,
          activeContainerNames: previousContainers.map(getContainerName),
          candidateContainerNames: candidateNames,
        })
      );
    }
  }

  const candidateIds = new Map<string, string>();
  try {
    for (const candidate of candidateSpecs) {
      const id = await docker.ensureContainer(candidate.spec, false, { pull: false });
      candidateIds.set(candidate.containerName, id);
    }
    for (const candidate of candidateSpecs) {
      await waitForWorkerReadiness(docker, {
        containerName: candidate.containerName,
        hasHealthcheck: candidate.hasHealthcheck,
      });
    }
  } catch (error) {
    for (const candidateName of candidateNames) {
      await docker.removeContainer(candidateName, true);
    }

    let liveRuntimePreserved = previousContainers.length > 0;
    let rollbackCompleted = false;
    if (snapshotName && payload.volume) {
      try {
        await assertNoUnexpectedVolumeConsumer(docker, payload.volume.volumeName, new Set());
        await restoreWorkerVolumeSnapshot(docker, environment, payload, snapshotName);
        liveRuntimePreserved = await restorePreviousWorkerVolumeRuntimeIfSafe(
          docker,
          payload.volume.volumeName,
          previousContainers
        );
        rollbackCompleted = liveRuntimePreserved;
      } catch {
        liveRuntimePreserved = false;
      }
      await deleteWorkerVolumeSnapshotBestEffort(docker, environment, payload, snapshotName);
    }
    if (
      environment.imageStoreMode === "docker-local" &&
      !shouldRetainWorkerImage(payload.runtimeMetadata, payload.imageUrl)
    ) {
      await docker.removeImage(payload.imageUrl, true);
    }
    throw new WorkerRolloutError(
      error instanceof Error ? error.message : "Worker candidate failed readiness checks",
      buildWorkerRolloutResult({
        strategy: isVolumeCutover ? "single_writer_snapshot_cutover" : "candidate_ready_cutover",
        outcome: "aborted_before_cutover",
        currentPhase: snapshotName ? "restore" : "ready",
        liveRuntimePreserved,
        rollbackCompleted,
        activeContainerNames: previousContainers.map(getContainerName),
        candidateContainerNames: candidateNames,
      })
    );
  }

  for (const container of previousContainers) {
    await docker.removeContainer(getContainerIdentifier(container), true);
  }
  if (snapshotName) {
    await deleteWorkerVolumeSnapshotBestEffort(docker, environment, payload, snapshotName);
  }

  const previousCurrentImage = resolveCurrentRuntimeImage(payload.runtimeMetadata);
  const retainedPreviousImage = resolvePreviousRuntimeImage(payload.runtimeMetadata);
  const nextCurrentImage: RuntimeRetainedImage = image
    ? {
        reference: payload.imageUrl,
        imageId: image.Id,
        deploymentId: payload.deploymentId,
        commitHash: payload.commitHash,
      }
    : (previousCurrentImage ?? {
        reference: payload.imageUrl,
        imageId: null,
        deploymentId: payload.deploymentId,
        commitHash: payload.commitHash,
      });
  const nextPreviousImage = previousCurrentImage ? { ...previousCurrentImage } : null;
  if (
    environment.imageStoreMode === "docker-local" &&
    retainedPreviousImage &&
    !sameRetainedImage(retainedPreviousImage, nextCurrentImage) &&
    !sameRetainedImage(retainedPreviousImage, nextPreviousImage)
  ) {
    const retainedReference = retainedPreviousImage.reference || retainedPreviousImage.imageId;
    if (retainedReference) {
      await docker.removeImage(retainedReference, true);
    }
  }

  const runtimeInstances: WorkerRuntimeInstance[] = candidateSpecs.map(
    (candidate, replicaIndex) => ({
      kind: "worker",
      status: "running",
      replicaIndex,
      name: candidate.containerName,
      image: payload.imageUrl,
      containerId: candidateIds.get(candidate.containerName) ?? candidate.containerName,
      containerName: candidate.containerName,
      networkName: candidate.projectNetwork,
      internalHost: candidate.containerName,
    })
  );
  const imageCommand = candidateSpecs[0]?.imageCommand ?? detectWorkerImageCommand(image);

  return {
    imageUrl: payload.imageUrl,
    runtimeMetadata: {
      image: payload.imageUrl,
      imageStoreMode: environment.imageStoreMode,
      currentImage: nextCurrentImage,
      previousImage: nextPreviousImage,
      ingressHost: null,
      ingressPort: null,
      publishedPort: null,
      internalPort: null,
      containerId: runtimeInstances[0]?.containerId ?? null,
      containerName: runtimeInstances[0]?.containerName ?? null,
      networkName: projectNetwork,
      replicaCount: payload.replicaCount,
      replicas: runtimeInstances.map((instance) => ({
        replicaIndex: instance.replicaIndex,
        containerId: instance.containerId,
        containerName: instance.containerName,
      })),
      detectedEntrypoint: imageCommand?.entrypoint ?? null,
      detectedCommand: imageCommand?.command ?? null,
      detectedCommandDisplay: imageCommand?.display ?? null,
      workerCommand: normalizeWorkerCommand(payload.startCommand),
      workerHealthCheckCommand: normalizeWorkerCommand(payload.healthCheckCommand),
    },
    rollout: buildWorkerRolloutResult({
      strategy: isVolumeCutover ? "single_writer_snapshot_cutover" : "candidate_ready_cutover",
      outcome: "committed",
      currentPhase: "retire",
      liveRuntimePreserved: false,
      rollbackCompleted: false,
      activeContainerNames: candidateNames,
      candidateContainerNames: candidateNames,
    }),
    runtimeInstances,
    ...(runtimeInstances[0] ? { runtimeInstance: runtimeInstances[0] } : {}),
  };
}

function getWorkerJobReceiptPath(dataDir: string, scheduleRunId: string): string {
  return path.join(
    dataDir,
    "worker-job-receipts",
    `${Buffer.from(scheduleRunId).toString("base64url")}.json`
  );
}

async function readWorkerJobReceipt(
  environment: Pick<WorkerRuntimeEnvironment, "dataDir">,
  scheduleRunId: string
): Promise<WorkerJobReceipt | null> {
  try {
    const raw = await readFile(getWorkerJobReceiptPath(environment.dataDir, scheduleRunId), "utf8");
    const parsed = JSON.parse(raw) as Partial<WorkerJobReceipt>;
    if (
      parsed.version !== 1 ||
      parsed.scheduleRunId !== scheduleRunId ||
      typeof parsed.projectId !== "string" ||
      typeof parsed.serviceId !== "string" ||
      typeof parsed.deploymentId !== "string" ||
      typeof parsed.scheduleId !== "string" ||
      typeof parsed.occurrenceKey !== "string" ||
      typeof parsed.jobName !== "string" ||
      typeof parsed.imageUrl !== "string" ||
      typeof parsed.containerId !== "string" ||
      typeof parsed.containerName !== "string" ||
      typeof parsed.status !== "string"
    ) {
      throw new Error(`Worker job receipt for ${scheduleRunId} is invalid`);
    }
    return parsed as WorkerJobReceipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeWorkerJobReceipt(
  environment: Pick<WorkerRuntimeEnvironment, "dataDir">,
  receipt: WorkerJobReceipt
): Promise<void> {
  const receiptPath = getWorkerJobReceiptPath(environment.dataDir, receipt.scheduleRunId);
  await mkdir(path.dirname(receiptPath), { recursive: true });
  const temporaryPath = `${receiptPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(receipt)}\n`, "utf8");
  await rename(temporaryPath, receiptPath);
}

function isWorkerJobTerminal(receipt: WorkerJobReceipt): boolean {
  return ["succeeded", "failed", "cancelled", "missing"].includes(receipt.status);
}

function readWorkerJobReceiptTimestamp(value: string | undefined): string | null {
  if (!value || value.startsWith("0001-")) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function readRequiredWorkerJobLabel(
  labels: Record<string, string> | undefined,
  key: string
): string | null {
  const value = labels?.[key]?.trim();
  return value ? value : null;
}

function recoverWorkerJobReceiptFromContainer(input: {
  container: DockerContainerInspection;
  serviceId: string;
  scheduleRunId: string;
  expected?: {
    projectId?: string;
    deploymentId?: string;
    scheduleId?: string;
    occurrenceKey?: string;
  };
}): WorkerJobReceipt | null {
  const labels = input.container.Config?.Labels;
  const containerName = getContainerName(input.container);
  if (
    labels?.["nouva.managed"] !== "true" ||
    labels["nouva.kind"] !== "worker_job" ||
    labels["nouva.service.type"] !== "worker" ||
    labels["nouva.service.id"] !== input.serviceId ||
    labels["nouva.schedule.run.id"] !== input.scheduleRunId ||
    containerName !== buildWorkerJobContainerName(input.serviceId, input.scheduleRunId)
  ) {
    return null;
  }

  if (
    (input.expected?.projectId && labels["nouva.project.id"] !== input.expected.projectId) ||
    (input.expected?.deploymentId &&
      labels["nouva.deployment.id"] !== input.expected.deploymentId) ||
    (input.expected?.scheduleId && labels["nouva.schedule.id"] !== input.expected.scheduleId) ||
    (input.expected?.occurrenceKey &&
      labels["nouva.schedule.occurrence.key"] !== input.expected.occurrenceKey)
  ) {
    return null;
  }

  const projectId = readRequiredWorkerJobLabel(labels, "nouva.project.id");
  const deploymentId = readRequiredWorkerJobLabel(labels, "nouva.deployment.id");
  const scheduleId = readRequiredWorkerJobLabel(labels, "nouva.schedule.id");
  const occurrenceKey = readRequiredWorkerJobLabel(labels, "nouva.schedule.occurrence.key");
  const imageUrl = input.container.Config?.Image?.trim() || null;
  const containerId = input.container.Id?.trim() || null;
  if (!projectId || !deploymentId || !scheduleId || !occurrenceKey || !imageUrl || !containerId) {
    return null;
  }

  const createdAt =
    readWorkerJobReceiptTimestamp(input.container.State?.StartedAt) ?? new Date().toISOString();
  const receipt: WorkerJobReceipt = {
    version: 1,
    projectId,
    serviceId: input.serviceId,
    deploymentId,
    scheduleRunId: input.scheduleRunId,
    scheduleId,
    occurrenceKey,
    jobName: containerName,
    imageUrl,
    containerId,
    containerName,
    status: "created",
    exitCode: null,
    createdAt,
    completedAt: null,
  };
  if (input.container.State?.Running) {
    return { ...receipt, status: "running" };
  }
  if (input.container.State?.Status?.toLowerCase() === "created") {
    return receipt;
  }

  const exitCode = input.container.State?.ExitCode ?? 1;
  return {
    ...receipt,
    status: exitCode === 0 ? "succeeded" : "failed",
    exitCode,
    completedAt:
      readWorkerJobReceiptTimestamp(input.container.State?.FinishedAt) ?? new Date().toISOString(),
  };
}

async function recoverMissingWorkerJobReceipt(
  docker: Pick<DockerApiClient, "inspectContainer">,
  environment: Pick<WorkerRuntimeEnvironment, "dataDir">,
  input: {
    serviceId: string;
    scheduleRunId: string;
    expected?: {
      projectId?: string;
      deploymentId?: string;
      scheduleId?: string;
      occurrenceKey?: string;
    };
  }
): Promise<WorkerJobReceipt | null> {
  const containerName = buildWorkerJobContainerName(input.serviceId, input.scheduleRunId);
  const container = await docker.inspectContainer(containerName);
  if (!container) {
    return null;
  }

  const receipt = recoverWorkerJobReceiptFromContainer({
    ...input,
    container,
  });
  if (!receipt) {
    throw new Error(
      `Worker job container ${containerName} exists but does not match the scheduled run receipt`
    );
  }
  await writeWorkerJobReceipt(environment, receipt);
  return receipt;
}

function buildWorkerJobRuntimeInstance(input: {
  receipt: WorkerJobReceipt;
  status: WorkerJobReceipt["status"];
}): Record<string, unknown> {
  return {
    kind: "worker_job",
    status: input.status,
    projectId: input.receipt.projectId,
    serviceId: input.receipt.serviceId,
    deploymentId: input.receipt.deploymentId,
    scheduleId: input.receipt.scheduleId,
    scheduleRunId: input.receipt.scheduleRunId,
    workerScheduleRunId: input.receipt.scheduleRunId,
    occurrenceKey: input.receipt.occurrenceKey,
    replicaIndex: null,
    name: input.receipt.containerName,
    image: input.receipt.imageUrl,
    containerId: input.receipt.containerId,
    containerName: input.receipt.containerName,
    networkName: getWorkerProjectNetwork(input.receipt.projectId),
    exitCode: input.receipt.exitCode,
    startedAt: input.receipt.createdAt,
    completedAt: input.receipt.completedAt,
  };
}

function toTerminalWorkerJobReceipt(
  receipt: WorkerJobReceipt,
  inspection: DockerContainerInspection | null,
  fallbackStatus: "cancelled" | "missing" = "missing"
): WorkerJobReceipt {
  if (!inspection) {
    return {
      ...receipt,
      status: fallbackStatus,
      completedAt: receipt.completedAt ?? new Date().toISOString(),
    };
  }
  const exitCode = inspection.State?.ExitCode ?? 1;
  return {
    ...receipt,
    status: exitCode === 0 ? "succeeded" : "failed",
    exitCode,
    completedAt: receipt.completedAt ?? new Date().toISOString(),
  };
}

async function assertWorkerJobVolumeAvailable(
  docker: Pick<DockerApiClient, "listContainersUsingVolume">,
  volume: AppVolumeIdentity | null | undefined
): Promise<void> {
  if (!volume) {
    return;
  }
  const consumers = await docker.listContainersUsingVolume(volume.volumeName);
  if (consumers.some((container) => container.State?.Running)) {
    throw new Error(`Volume ${volume.volumeName} already has a running consumer`);
  }
}

export async function startWorkerJob(
  docker: WorkerRuntimeDocker,
  environment: WorkerRuntimeEnvironment,
  payload: WorkerJobPayload
): Promise<Record<string, unknown>> {
  const command = normalizeWorkerCommand(payload.command);
  if (!command) {
    throw new Error("Scheduled worker jobs require an explicit command");
  }
  assertWorkerJobTimeout(payload.timeoutSeconds);

  let existingReceipt = await readWorkerJobReceipt(environment, payload.scheduleRunId);
  if (!existingReceipt) {
    existingReceipt = await recoverMissingWorkerJobReceipt(docker, environment, {
      serviceId: payload.serviceId,
      scheduleRunId: payload.scheduleRunId,
      expected: {
        projectId: payload.projectId,
        deploymentId: payload.deploymentId,
        scheduleId: payload.scheduleId,
        occurrenceKey: payload.occurrenceKey,
      },
    });
  }
  if (existingReceipt) {
    if (isWorkerJobTerminal(existingReceipt)) {
      return {
        job: buildWorkerJobRuntimeInstance({
          receipt: existingReceipt,
          status: existingReceipt.status,
        }),
        runtimeInstances: [
          buildWorkerJobRuntimeInstance({
            receipt: existingReceipt,
            status: existingReceipt.status,
          }),
        ],
        containerReceipt: existingReceipt,
      };
    }
    const existingContainer = await docker.inspectContainer(existingReceipt.containerId);
    if (existingContainer?.State?.Running) {
      return {
        job: buildWorkerJobRuntimeInstance({
          receipt: { ...existingReceipt, status: "running" },
          status: "running",
        }),
        containerReceipt: existingReceipt,
      };
    }
    if (existingReceipt.status === "created" && existingContainer?.State?.Status === "created") {
      await docker.startContainer(existingReceipt.containerId);
      const runningReceipt = { ...existingReceipt, status: "running" as const };
      await writeWorkerJobReceipt(environment, runningReceipt);
      return {
        job: buildWorkerJobRuntimeInstance({
          receipt: runningReceipt,
          status: "running",
        }),
        containerReceipt: runningReceipt,
      };
    }
    if (existingContainer) {
      const terminalReceipt = toTerminalWorkerJobReceipt(existingReceipt, existingContainer);
      await writeWorkerJobReceipt(environment, terminalReceipt);
      return {
        job: buildWorkerJobRuntimeInstance({
          receipt: terminalReceipt,
          status: terminalReceipt.status,
        }),
        containerReceipt: terminalReceipt,
      };
    }
    const missingReceipt = toTerminalWorkerJobReceipt(existingReceipt, null);
    await writeWorkerJobReceipt(environment, missingReceipt);
    return {
      job: buildWorkerJobRuntimeInstance({
        receipt: missingReceipt,
        status: missingReceipt.status,
      }),
      containerReceipt: missingReceipt,
    };
  }

  await assertWorkerJobVolumeAvailable(docker, payload.volume);
  const projectNetwork = getWorkerProjectNetwork(payload.projectId);
  await docker.ensureNetwork(projectNetwork, {
    "nouva.managed": "true",
    "nouva.server.id": environment.serverId,
    "nouva.project.id": payload.projectId,
  });
  await ensureWorkerImage(docker, environment, payload.imageUrl);
  const containerName = buildWorkerJobContainerName(payload.serviceId, payload.scheduleRunId);
  if (await docker.inspectContainer(containerName)) {
    throw new Error(
      `Worker job container ${containerName} exists but its receipt could not be recovered. ` +
        "Refusing to run the command again."
    );
  }
  const containerId = await docker.createContainer({
    name: containerName,
    image: payload.imageUrl,
    env: Object.entries(payload.envVars).map(([key, value]) => `${key}=${value}`),
    entrypoint: ["/bin/sh", "-lc"],
    cmd: [command],
    labels: buildWorkerLabels({
      serverId: environment.serverId,
      kind: "worker_job",
      projectId: payload.projectId,
      environmentId: payload.environmentId ?? null,
      serviceId: payload.serviceId,
      deploymentId: payload.deploymentId,
      scheduleId: payload.scheduleId,
      scheduleRunId: payload.scheduleRunId,
      occurrenceKey: payload.occurrenceKey,
    }),
    hostConfig: {
      ...(payload.volume
        ? {
            Mounts: [
              {
                Type: "volume",
                Source: payload.volume.volumeName,
                Target: payload.volume.mountPath,
              },
            ],
          }
        : {}),
      RestartPolicy: { Name: "no" },
      ...toDockerResourceSettings(payload.resourceLimits),
    },
    networkingConfig: {
      EndpointsConfig: {
        [projectNetwork]: {},
      },
    },
  });
  const receipt: WorkerJobReceipt = {
    version: 1,
    projectId: payload.projectId,
    serviceId: payload.serviceId,
    deploymentId: payload.deploymentId,
    scheduleRunId: payload.scheduleRunId,
    scheduleId: payload.scheduleId,
    occurrenceKey: payload.occurrenceKey,
    jobName: payload.jobName,
    imageUrl: payload.imageUrl,
    containerId,
    containerName,
    status: "created",
    exitCode: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
  };
  await writeWorkerJobReceipt(environment, receipt);
  await docker.startContainer(containerId);
  const runningReceipt = { ...receipt, status: "running" as const };
  await writeWorkerJobReceipt(environment, runningReceipt);
  const job = buildWorkerJobRuntimeInstance({
    receipt: runningReceipt,
    status: "running",
  });
  return {
    job,
    runtimeInstances: [job],
    containerReceipt: runningReceipt,
    timeoutSeconds: payload.timeoutSeconds,
  };
}

export async function inspectWorkerJob(
  docker: Pick<DockerApiClient, "inspectContainer">,
  environment: Pick<WorkerRuntimeEnvironment, "dataDir">,
  payload: Pick<WorkerJobLifecyclePayload, "scheduleRunId">
): Promise<Record<string, unknown>> {
  const receipt = await readWorkerJobReceipt(environment, payload.scheduleRunId);
  if (!receipt) {
    throw new Error(`Worker job receipt ${payload.scheduleRunId} was not found`);
  }
  if (isWorkerJobTerminal(receipt)) {
    return {
      job: buildWorkerJobRuntimeInstance({
        receipt,
        status: receipt.status,
      }),
      containerReceipt: receipt,
    };
  }
  const inspection = await docker.inspectContainer(receipt.containerId);
  if (inspection?.State?.Running) {
    return {
      job: buildWorkerJobRuntimeInstance({
        receipt: { ...receipt, status: "running" },
        status: "running",
      }),
      containerReceipt: receipt,
    };
  }
  const terminalReceipt = toTerminalWorkerJobReceipt(receipt, inspection);
  await writeWorkerJobReceipt(environment, terminalReceipt);
  return {
    job: buildWorkerJobRuntimeInstance({
      receipt: terminalReceipt,
      status: terminalReceipt.status,
    }),
    containerReceipt: terminalReceipt,
  };
}

export async function stopWorkerJob(
  docker: Pick<DockerApiClient, "inspectContainer" | "stopContainer">,
  environment: Pick<WorkerRuntimeEnvironment, "dataDir">,
  payload: Pick<WorkerJobLifecyclePayload, "scheduleRunId">
): Promise<Record<string, unknown>> {
  const receipt = await readWorkerJobReceipt(environment, payload.scheduleRunId);
  if (!receipt) {
    throw new Error(`Worker job receipt ${payload.scheduleRunId} was not found`);
  }
  if (isWorkerJobTerminal(receipt)) {
    return {
      job: buildWorkerJobRuntimeInstance({
        receipt,
        status: receipt.status,
      }),
      containerReceipt: receipt,
    };
  }
  await docker.stopContainer(receipt.containerId);
  const inspection = await docker.inspectContainer(receipt.containerId);
  const stoppedReceipt: WorkerJobReceipt = {
    ...receipt,
    status: "cancelled",
    exitCode: inspection?.State?.ExitCode ?? receipt.exitCode,
    completedAt: new Date().toISOString(),
  };
  await writeWorkerJobReceipt(environment, stoppedReceipt);
  return {
    job: buildWorkerJobRuntimeInstance({
      receipt: stoppedReceipt,
      status: stoppedReceipt.status,
    }),
    containerReceipt: stoppedReceipt,
  };
}

export async function cleanupWorkerJob(
  docker: Pick<DockerApiClient, "inspectContainer" | "removeContainer">,
  environment: Pick<WorkerRuntimeEnvironment, "dataDir">,
  payload: Pick<WorkerJobLifecyclePayload, "serviceId" | "scheduleRunId">
): Promise<Record<string, unknown>> {
  let receipt = await readWorkerJobReceipt(environment, payload.scheduleRunId);
  if (!receipt) {
    receipt = await recoverMissingWorkerJobReceipt(docker, environment, {
      serviceId: payload.serviceId,
      scheduleRunId: payload.scheduleRunId,
    });
  }
  if (!receipt) {
    return {
      cleanupProof: {
        version: 1,
        kind: "cleanup_worker_job",
        container: {
          identifier: buildWorkerJobContainerName(payload.serviceId, payload.scheduleRunId),
          absent: true,
        },
      },
    };
  }
  const inspection = await docker.inspectContainer(receipt.containerId);
  if (inspection?.State?.Running) {
    throw new Error(
      `Worker job ${payload.scheduleRunId} is still running and cannot be cleaned up`
    );
  }
  await docker.removeContainer(receipt.containerId, true);
  if (await docker.inspectContainer(receipt.containerId)) {
    throw new Error(`Worker job container ${receipt.containerName} still exists after cleanup`);
  }
  await rm(getWorkerJobReceiptPath(environment.dataDir, payload.scheduleRunId), { force: true });
  return {
    containerReceipt: receipt,
    cleanupProof: {
      version: 1,
      kind: "cleanup_worker_job",
      container: { identifier: receipt.containerId, absent: true },
    },
  };
}

export async function removeWorkerServiceRuntime(
  docker: Pick<
    DockerApiClient,
    "inspectContainer" | "listContainersByLabels" | "removeContainer" | "removeImage"
  >,
  input: {
    serviceId: string;
    runtimeMetadata?: RuntimeMetadata | null;
  }
): Promise<Record<string, unknown>> {
  const containers = await listWorkerManagedContainers(docker, input.serviceId);
  const identifiers = containers.map(getContainerIdentifier);
  for (const identifier of identifiers) {
    await docker.removeContainer(identifier, true);
  }
  for (const identifier of identifiers) {
    if (await docker.inspectContainer(identifier)) {
      throw new Error(`Worker container ${identifier} still exists after cleanup`);
    }
  }

  const retainedImages =
    input.runtimeMetadata?.imageStoreMode === "docker-local"
      ? getRetainedImageReferences(input.runtimeMetadata)
      : [];
  for (const reference of retainedImages) {
    await docker.removeImage(reference, true);
  }

  return {
    runtimeInstances: containers.map((container) => {
      const kind = container.Config?.Labels?.["nouva.kind"];
      const replicaIndex = Number(container.Config?.Labels?.["nouva.replica.index"]);
      return {
        kind: kind === "worker_job" ? "worker_job" : "worker",
        status: "removed",
        replicaIndex: Number.isInteger(replicaIndex) ? replicaIndex : null,
        workerScheduleRunId:
          kind === "worker_job"
            ? (container.Config?.Labels?.["nouva.schedule.run.id"] ?? null)
            : null,
        containerId: container.Id,
        containerName: getContainerName(container),
      };
    }),
    cleanupProof: {
      version: 1,
      kind: "delete_worker",
      containers: identifiers.map((identifier) => ({ identifier, absent: true })),
      retainedImages: retainedImages.map((reference) => ({ reference, absent: true })),
    },
  };
}

export async function restartWorkerServiceRuntime(
  docker: Pick<DockerApiClient, "listContainersByLabels" | "restartContainer">,
  serviceId: string
): Promise<Record<string, unknown>> {
  const containers = await listWorkerServiceContainers(docker, serviceId);
  if (containers.length === 0) {
    throw new Error(`Worker ${serviceId} has no runtime containers to restart`);
  }
  for (const container of containers) {
    await docker.restartContainer(getContainerIdentifier(container));
  }
  return {
    runtimeInstances: containers.map((container) => {
      const replicaIndex = Number(container.Config?.Labels?.["nouva.replica.index"]);
      return {
        kind: "worker",
        status: "running",
        replicaIndex: Number.isInteger(replicaIndex) ? replicaIndex : null,
        containerId: container.Id,
        containerName: getContainerName(container),
      };
    }),
  };
}
