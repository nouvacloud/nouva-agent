import {
  assessCandidateReadiness,
  type CandidateRuntimeEvidence,
  NO_CANDIDATE_RUNTIME_EVIDENCE,
} from "./app-candidate-readiness.js";
import type { DockerApiClient, DockerContainerInspection } from "./docker-api.js";
import type {
  AgentDatabaseRuntimeHealthObservation,
  AgentDatabaseRuntimeHealthReason,
  AgentDatabaseRuntimeHealthReport,
  AgentDatabaseRuntimeHealthState,
  DatabaseServiceVariant,
} from "./protocol.js";

/**
 * Truthful readiness and continuing health for managed database containers.
 *
 * A started Docker container is not a usable database: the engine can refuse to start, exit into a
 * restart loop, or still be running its one-time initialization. Every verdict this module reports
 * as "ready" is therefore backed by an authenticated statement executed against the container's
 * service-facing address on the managed project network — not against the temporary loopback
 * bootstrap server the official images run while initializing a data directory.
 *
 * Failure reporting is deliberately structured: container state, closed failure categories, and one
 * recognized upstream incompatibility signature. Raw container logs and probe output are never
 * echoed, because database logs are untrusted material that can carry credentials.
 */

export type DatabaseEngine = DatabaseServiceVariant;

export interface DatabaseProbeCredentials {
  username: string;
  password: string;
  database?: string | null;
}

export interface DatabaseReadinessProbeCommand {
  /** Credential values reach the sidecar only here, never as command literals. */
  env: string[];
  /**
   * Replaces the image's own entrypoint.
   *
   * Managed database images start a database when they run: the Nouva PostgreSQL image initializes
   * a cluster and launches PgBouncer and ignores the command entirely. A probe must therefore run
   * its shell directly instead of asking the image to run it.
   */
  entrypoint: string[];
  cmd: string[];
}

const PROBE_ENTRYPOINT = ["/bin/sh"];

const PROBE_PASSWORD_ENV = "NOUVA_PROBE_PASSWORD";

/**
 * MongoDB aborts with this fatal message when its own kernel guard rejects the host kernel
 * (upstream MongoDB SERVER-121912, and SERVER-131779 for the Ubuntu kernel versioning correction).
 * Only this exact signature is recognized, and only to select a static message: no log text is ever
 * exported, and the guard is never bypassed.
 *
 * The message states what the runtime observed and what to do about it. Whether an upstream fix has
 * shipped is not something this build can assert, so the user is pointed at the upstream issues
 * rather than told a fix does not exist.
 */
const MONGODB_KERNEL_GUARD_SIGNATURE = /MongoDB cannot start: Linux kernel versions/;

const MONGODB_KERNEL_GUARD_MESSAGE =
  "this MongoDB build rejects the server's Linux kernel and refuses to start (upstream MongoDB SERVER-121912 and SERVER-131779). Use a MongoDB build and server kernel combination upstream supports; the guard cannot be safely bypassed.";

export type DatabaseReadinessFailureCategory =
  | "container_missing"
  | "container_failed"
  | "incompatible_host_kernel"
  | "unready_deadline";

export class DatabaseReadinessError extends Error {
  constructor(
    message: string,
    readonly category: DatabaseReadinessFailureCategory
  ) {
    super(message);
    this.name = "DatabaseReadinessError";
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Builds the authenticated readiness statement for one engine.
 *
 * `host` must be the managed container's network address: the official PostgreSQL, MySQL and
 * MongoDB entrypoints accept local connections on a temporary initialization server before the real
 * server is listening, so a loopback probe can report a database that is not actually serving.
 */
export function buildDatabaseReadinessProbe(input: {
  engine: DatabaseEngine;
  host: string;
  port: number;
  credentials: DatabaseProbeCredentials;
}): DatabaseReadinessProbeCommand {
  const { engine, host, port, credentials } = input;
  const database = credentials.database?.trim() || null;

  switch (engine) {
    case "postgres": {
      return {
        env: [
          `PGPASSWORD=${credentials.password}`,
          `PGHOST=${host}`,
          `PGPORT=${port}`,
          `PGUSER=${credentials.username}`,
          `PGDATABASE=${database ?? credentials.username}`,
          "PGCONNECT_TIMEOUT=5",
        ],
        entrypoint: PROBE_ENTRYPOINT,
        cmd: [
          "-c",
          ["set -eu", `psql -w -X -t -A -v ON_ERROR_STOP=1 -c "SELECT 1" >/dev/null 2>&1`].join(
            "\n"
          ),
        ],
      };
    }
    case "mongodb": {
      return {
        env: [
          `${PROBE_PASSWORD_ENV}=${credentials.password}`,
          `NOUVA_PROBE_USERNAME=${credentials.username}`,
          `NOUVA_PROBE_HOST=${host}`,
          `NOUVA_PROBE_PORT=${port}`,
        ],
        entrypoint: PROBE_ENTRYPOINT,
        cmd: [
          "-c",
          [
            "set -eu",
            // db.adminCommand({ping:1}) requires a successful authentication against the
            // service-facing listener, so an initializing server cannot satisfy it.
            `mongosh --quiet --host "$NOUVA_PROBE_HOST" --port "$NOUVA_PROBE_PORT" -u "$NOUVA_PROBE_USERNAME" -p "$${PROBE_PASSWORD_ENV}" --authenticationDatabase admin --eval 'if (db.adminCommand({ ping: 1 }).ok !== 1) { quit(1); }' >/dev/null 2>&1`,
          ].join("\n"),
        ],
      };
    }
    case "mysql": {
      return {
        env: [
          // MYSQL_PWD authenticates without placing the password on argv inside the sidecar.
          `MYSQL_PWD=${credentials.password}`,
          `NOUVA_PROBE_USERNAME=${credentials.username}`,
          `NOUVA_PROBE_HOST=${host}`,
          `NOUVA_PROBE_PORT=${port}`,
        ],
        entrypoint: PROBE_ENTRYPOINT,
        cmd: [
          "-c",
          [
            "set -eu",
            // A SELECT proves authorization; `mysqladmin ping` answers successfully even when the
            // server rejects the account with "access denied".
            `mysql -h"$NOUVA_PROBE_HOST" -P"$NOUVA_PROBE_PORT" -u"$NOUVA_PROBE_USERNAME" --protocol=tcp --connect-timeout=5 -N -B -e "SELECT 1" >/dev/null 2>&1`,
          ].join("\n"),
        ],
      };
    }
    case "redis": {
      return {
        env: [
          // REDISCLI_AUTH keeps the password off argv; without it the server answers NOAUTH.
          `REDISCLI_AUTH=${credentials.password}`,
          `NOUVA_PROBE_HOST=${host}`,
          `NOUVA_PROBE_PORT=${port}`,
        ],
        entrypoint: PROBE_ENTRYPOINT,
        cmd: [
          "-c",
          [
            "set -eu",
            `reply=$(redis-cli -h "$NOUVA_PROBE_HOST" -p "$NOUVA_PROBE_PORT" PING 2>/dev/null)`,
            `test "$reply" = ${shellQuote("PONG")}`,
          ].join("\n"),
        ],
      };
    }
  }
}

/**
 * The environment and arguments a managed database container runs with, whether taken from a live
 * container or from the runtime definition the control plane sent to create it.
 */
export interface DatabaseRuntimeDefinition {
  envVars: Record<string, string>;
  containerArgs: string[];
}

function readEnvValue(runtime: DatabaseRuntimeDefinition, name: string): string | null {
  const value = runtime.envVars[name];
  return value && value.length > 0 ? value : null;
}

function readRedisPassword(runtime: DatabaseRuntimeDefinition): string | null {
  const index = runtime.containerArgs.indexOf("--requirepass");
  const password = index === -1 ? null : (runtime.containerArgs[index + 1] ?? null);
  return password && password.length > 0 ? password : null;
}

function toRuntimeDefinition(inspection: DockerContainerInspection): DatabaseRuntimeDefinition {
  const envVars: Record<string, string> = {};
  for (const entry of inspection.Config?.Env ?? []) {
    const separator = entry.indexOf("=");
    if (separator > 0) {
      envVars[entry.slice(0, separator)] = entry.slice(separator + 1);
    }
  }

  return { envVars, containerArgs: inspection.Config?.Cmd ?? [] };
}

/**
 * Recovers the credentials a managed container was started with, so continuing health checks can
 * authenticate without the control plane re-sending secrets on every heartbeat. The values already
 * live in this container's own configuration on this host; they are never logged or reported.
 */
export function readDatabaseProbeCredentials(
  engine: DatabaseEngine,
  inspection: DockerContainerInspection
): DatabaseProbeCredentials | null {
  return readDatabaseProbeCredentialsFromRuntime(engine, toRuntimeDefinition(inspection));
}

/**
 * Reads the credentials a database will accept from the runtime definition it runs with.
 *
 * Provisioning uses this so readiness authenticates with exactly the account the image is being
 * created with, rather than depending on a separate credential field travelling with the request.
 */
export function readDatabaseProbeCredentialsFromRuntime(
  engine: DatabaseEngine,
  runtime: DatabaseRuntimeDefinition
): DatabaseProbeCredentials | null {
  switch (engine) {
    case "postgres": {
      const username = readEnvValue(runtime, "POSTGRES_USER");
      const password = readEnvValue(runtime, "POSTGRES_PASSWORD");
      return username && password
        ? { username, password, database: readEnvValue(runtime, "POSTGRES_DB") ?? username }
        : null;
    }
    case "mongodb": {
      const username = readEnvValue(runtime, "MONGO_INITDB_ROOT_USERNAME");
      const password = readEnvValue(runtime, "MONGO_INITDB_ROOT_PASSWORD");
      return username && password ? { username, password, database: "admin" } : null;
    }
    case "mysql": {
      const username = readEnvValue(runtime, "MYSQL_USER");
      const password = readEnvValue(runtime, "MYSQL_PASSWORD");
      return username && password
        ? { username, password, database: readEnvValue(runtime, "MYSQL_DATABASE") }
        : null;
    }
    case "redis": {
      const password = readRedisPassword(runtime);
      return password ? { username: "default", password, database: null } : null;
    }
  }
}

type ReadinessDocker = Pick<DockerApiClient, "inspectContainer" | "containerLogs">;

async function hasKnownKernelIncompatibility(
  docker: ReadinessDocker,
  containerName: string
): Promise<boolean> {
  try {
    return MONGODB_KERNEL_GUARD_SIGNATURE.test(await docker.containerLogs(containerName));
  } catch {
    // Log retrieval is diagnostic only: a failure here must not change the reported verdict.
    return false;
  }
}

function describeKernelIncompatibility(containerName: string): string {
  return `Database container ${containerName} cannot start: ${MONGODB_KERNEL_GUARD_MESSAGE}`;
}

const DEFAULT_READINESS_TIMEOUT_MS = 180_000;
const DEFAULT_READINESS_INTERVAL_MS = 2_000;
const DEFAULT_READINESS_PROBE_INTERVAL_MS = 10_000;

const DATABASE_READINESS_SUBJECT = "Database container";

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits until the database answers an authenticated statement, or fails with an actionable reason.
 *
 * Returns normally only after `probe` succeeds. Docker state alone never counts as ready. The wait
 * is bounded by `timeoutMs`; container state is re-read every `intervalMs` so a process that exits
 * or enters a restart loop is reported immediately instead of timing out as "not reachable".
 */
export async function waitForDatabaseReadiness(input: {
  docker: ReadinessDocker;
  containerName: string;
  engine: DatabaseEngine;
  probe: () => Promise<void>;
  timeoutMs?: number;
  intervalMs?: number;
  probeIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Restarts the container carried before this wait began; see `assessCandidateReadiness`. */
  restartBaseline?: number;
}): Promise<void> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? defaultSleep;
  const intervalMs = input.intervalMs ?? DEFAULT_READINESS_INTERVAL_MS;
  const probeIntervalMs = input.probeIntervalMs ?? DEFAULT_READINESS_PROBE_INTERVAL_MS;
  const timeoutMs = input.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const deadline = now() + timeoutMs;
  const { containerName } = input;

  let evidence: CandidateRuntimeEvidence = NO_CANDIDATE_RUNTIME_EVIDENCE;
  let nextProbeAt = 0;
  let lastStatus = "unknown";

  while (now() <= deadline) {
    const inspection = await input.docker.inspectContainer(containerName);
    if (!inspection) {
      throw new DatabaseReadinessError(
        `Database container ${containerName} is missing on the server`,
        "container_missing"
      );
    }

    const assessment = assessCandidateReadiness({
      subject: DATABASE_READINESS_SUBJECT,
      restartBaseline: input.restartBaseline,
      containerName,
      // Reachability is proven by the authenticated probe, so the TCP step is never used here.
      appPort: 0,
      inspection,
      evidence,
    });
    evidence = assessment.evidence;
    lastStatus = inspection.State?.Status?.toLowerCase() ?? lastStatus;

    if (assessment.step.kind === "failed") {
      if (await hasKnownKernelIncompatibility(input.docker, containerName)) {
        throw new DatabaseReadinessError(
          describeKernelIncompatibility(containerName),
          "incompatible_host_kernel"
        );
      }

      throw new DatabaseReadinessError(assessment.step.message, "container_failed");
    }

    const containerIsUp = assessment.step.kind !== "wait" || inspection.State?.Running === true;
    if (containerIsUp && now() >= nextProbeAt) {
      nextProbeAt = now() + probeIntervalMs;
      try {
        await input.probe();
        return;
      } catch {
        // Probe output can carry credential material, so only the failure itself is carried
        // forward; the deadline message reports structured container state instead.
      }
    }

    await sleep(intervalMs);
  }

  if (await hasKnownKernelIncompatibility(input.docker, containerName)) {
    throw new DatabaseReadinessError(
      describeKernelIncompatibility(containerName),
      "incompatible_host_kernel"
    );
  }

  const restarts = evidence.restarts > 0 ? `, ${evidence.restarts} restarts` : "";
  throw new DatabaseReadinessError(
    `Database container ${containerName} did not accept authenticated ${input.engine} connections within ${Math.round(
      timeoutMs / 1000
    )}s (container status ${lastStatus}${restarts}); the database is not serving its port`,
    "unready_deadline"
  );
}

export interface ManagedDatabaseContainer {
  serviceId: string;
  containerId: string;
  containerName: string;
  engine: DatabaseEngine;
}

const UNAVAILABLE_CONTAINER_STATUSES: Record<string, AgentDatabaseRuntimeHealthReason> = {
  restarting: "container_restarting",
  exited: "container_exited",
  dead: "container_exited",
  removing: "container_exited",
  paused: "container_paused",
};

/**
 * Observes one managed database container for continuing health.
 *
 * `unavailable` is reported only from container state the host can prove (missing, restarting,
 * exited, paused). `ready` is reported only when an authenticated probe succeeds. Everything else —
 * a failing or unrunnable probe, unreadable credentials, a container still starting — is `unknown`,
 * so an unproven observation can never revive a failed service or fail a healthy one.
 */
export async function observeDatabaseRuntimeHealth(input: {
  docker: ReadinessDocker;
  container: ManagedDatabaseContainer;
  runProbe: DatabaseRuntimeProbeRunner;
  /** Read when the observation resolves, so an entry carries the instant it was actually observed. */
  now?: () => Date;
}): Promise<AgentDatabaseRuntimeHealthObservation> {
  const { container } = input;
  const now = input.now ?? (() => new Date());
  const report = (
    state: AgentDatabaseRuntimeHealthState,
    reason: AgentDatabaseRuntimeHealthReason
  ): AgentDatabaseRuntimeHealthObservation => ({
    serviceId: container.serviceId,
    containerId: container.containerId,
    containerName: container.containerName,
    engine: container.engine,
    state,
    reason,
    observedAt: now().toISOString(),
  });

  let inspection: DockerContainerInspection | null;
  try {
    inspection = await input.docker.inspectContainer(container.containerName);
  } catch {
    return report("unknown", "probe_unavailable");
  }

  if (!inspection) {
    return report("unavailable", "container_missing");
  }

  const status = inspection.State?.Status?.toLowerCase() ?? "";
  const unavailableReason = UNAVAILABLE_CONTAINER_STATUSES[status];
  if (unavailableReason) {
    if (await hasKnownKernelIncompatibility(input.docker, container.containerName)) {
      return report("unavailable", "incompatible_host_kernel");
    }
    return report("unavailable", unavailableReason);
  }

  if (inspection.State?.Running !== true) {
    return report("unknown", "probe_unavailable");
  }

  const credentials = readDatabaseProbeCredentials(container.engine, inspection);
  if (!credentials) {
    return report("unknown", "probe_unavailable");
  }

  try {
    await input.runProbe({
      container,
      inspection,
      probe: buildDatabaseReadinessProbe({
        engine: container.engine,
        host: container.containerName,
        port: resolveDatabaseInternalPort(container.engine, inspection),
        credentials,
      }),
    });
  } catch {
    return report("unknown", "probe_unavailable");
  }

  return report("ready", "authenticated_probe_succeeded");
}

/**
 * Runs one authenticated probe for an observed container. The inspection is supplied so the caller
 * can resolve the image and network the probe sidecar must use.
 */
export type DatabaseRuntimeProbeRunner = (input: {
  container: ManagedDatabaseContainer;
  inspection: DockerContainerInspection;
  probe: DatabaseReadinessProbeCommand;
}) => Promise<void>;

const DATABASE_ENGINES: readonly DatabaseEngine[] = ["postgres", "mongodb", "mysql", "redis"];

/**
 * A managed database container as the inventory sees it.
 *
 * `engine` is null when neither the variant label nor the managed container name resolves one. Such
 * a container is still inventoried: the control plane reads absence from the inventory as a missing
 * container, so dropping a database the host can plainly see would fail a healthy service.
 */
interface InventoriedDatabaseContainer {
  serviceId: string;
  containerId: string;
  containerName: string;
  engine: DatabaseEngine | null;
}

/**
 * Managed database containers are named `nouva-<engine>-<service>`; the variant label came later,
 * so containers created by an earlier agent carry the engine only in their name. The same fallback
 * already backs PostgreSQL observability (`isManagedPostgresContainer`).
 */
function readEngineFromContainerName(containerName: string): DatabaseEngine | null {
  return DATABASE_ENGINES.find((engine) => containerName.startsWith(`nouva-${engine}-`)) ?? null;
}

function readManagedDatabaseContainer(container: {
  Id: string;
  Names?: string[];
  Labels?: Record<string, string>;
}): InventoriedDatabaseContainer | null {
  const labels = container.Labels ?? {};
  const serviceId = labels["nouva.service.id"];
  const containerName = container.Names?.[0]?.replace(/^\//, "");
  if (labels["nouva.kind"] !== "database" || !serviceId || !containerName) {
    return null;
  }

  const labelled = labels["nouva.service.variant"] as DatabaseEngine | undefined;
  const engine =
    labelled && DATABASE_ENGINES.includes(labelled)
      ? labelled
      : readEngineFromContainerName(containerName);

  return { serviceId, containerId: container.Id, containerName, engine };
}

/** Concurrent observations per pass: enough to keep a pass short, few enough to stay out of the way. */
const DEFAULT_OBSERVATION_CONCURRENCY = 2;

/**
 * Observes every managed database container on this host.
 *
 * The result is a complete inventory as of `observedAt`: the control plane relies on that to treat a
 * service missing from it as a missing container, so a partial pass must never be reported.
 */
export async function collectDatabaseRuntimeHealthReport(input: {
  docker: Pick<DockerApiClient, "listManagedContainers" | "inspectContainer" | "containerLogs">;
  runProbe: DatabaseRuntimeProbeRunner;
  concurrency?: number;
  now?: () => Date;
  /**
   * Receives the inventory as soon as it is known and again after every observation completes.
   *
   * A pass over many databases takes as long as its probes. Publishing only at the end would make
   * the first database's evidence older than the control plane accepts on every pass, so it would
   * never act on it. Each call receives its own snapshot; earlier ones are never mutated.
   */
  onReport?: (report: AgentDatabaseRuntimeHealthReport) => void;
}): Promise<AgentDatabaseRuntimeHealthReport> {
  const now = input.now ?? (() => new Date());
  // Stamped before the listing: a container created while the list is being taken would otherwise be
  // absent from an inventory claiming to postdate it, which the control plane reads as missing.
  const observedAt = now().toISOString();
  const containers = (await input.docker.listManagedContainers())
    .map(readManagedDatabaseContainer)
    .filter((container): container is InventoriedDatabaseContainer => container !== null);

  // The inventory is complete from its first publication: a container that has not been probed yet
  // is reported as observed-but-unproven, never omitted, so absence keeps meaning absence. Each
  // entry is replaced by its real observation, stamped when that observation completed.
  const observations: AgentDatabaseRuntimeHealthObservation[] = containers.map((container) => ({
    serviceId: container.serviceId,
    containerId: container.containerId,
    containerName: container.containerName,
    engine: container.engine ?? "",
    state: "unknown",
    reason: "probe_unavailable",
    observedAt,
  }));

  const publish = (): AgentDatabaseRuntimeHealthReport => {
    const snapshot: AgentDatabaseRuntimeHealthReport = {
      observedAt,
      containers: observations.map((observation) => ({ ...observation })),
    };
    input.onReport?.(snapshot);
    return snapshot;
  };

  publish();

  const concurrency = Math.max(1, input.concurrency ?? DEFAULT_OBSERVATION_CONCURRENCY);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < containers.length) {
      const index = next;
      const container = containers[index];
      next += 1;
      if (!container) {
        continue;
      }

      // Present on the host, but nothing here can authenticate against it: it keeps the
      // observed-but-unproven placeholder it was inventoried with.
      if (container.engine === null) {
        continue;
      }

      observations[index] = await observeDatabaseRuntimeHealth({
        docker: input.docker,
        container: { ...container, engine: container.engine },
        runProbe: input.runProbe,
        now,
      });
      publish();
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, containers.length) }, () => worker())
  );

  return { observedAt, containers: observations.map((observation) => ({ ...observation })) };
}

const DEFAULT_ENGINE_PORTS: Record<DatabaseEngine, number> = {
  postgres: 5432,
  mongodb: 27017,
  mysql: 3306,
  redis: 6379,
};

/**
 * Docker only records the container-side port when the service publishes one, so an unpublished
 * database falls back to the engine's standard port. A service running on a non-standard port
 * without a published binding therefore fails its probe and is reported `unknown`, never revived.
 */
export function resolveDatabaseInternalPort(
  engine: DatabaseEngine,
  inspection: DockerContainerInspection
): number {
  for (const key of Object.keys(inspection.HostConfig?.PortBindings ?? {})) {
    const port = Number.parseInt(key.split("/")[0] ?? "", 10);
    if (Number.isInteger(port) && port > 0) {
      return port;
    }
  }

  return DEFAULT_ENGINE_PORTS[engine];
}
