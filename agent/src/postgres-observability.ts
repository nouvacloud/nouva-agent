import postgres from "postgres";
import type { DockerApiClient, DockerContainerInspection } from "./docker-api.js";
import type {
  AgentPostgresObservabilitySample,
  PostgresObservabilitySnapshot,
} from "./protocol.js";

const POSTGRES_CONTAINER_NAME_PREFIX = "/nouva-postgres-";
const POSTGRES_SERVER_PORT_FALLBACK = 5432;
const MAX_SLOW_QUERY_COUNT = 20;

type ManagedContainerRecord = Awaited<ReturnType<DockerApiClient["listManagedContainers"]>>[number];

type SlowQueryRow = {
  query_id: string | null;
  calls: number | string | null;
  total_time_ms: number | string | null;
  mean_time_ms: number | string | null;
  min_time_ms: number | string | null;
  max_time_ms: number | string | null;
  rows: number | string | null;
  query_text: string | null;
};

export interface ManagedPostgresTarget {
  serviceId: string;
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
}

function pickPgStatMonitorColumn(
  columns: Set<string>,
  candidates: readonly string[]
): string | null {
  for (const candidate of candidates) {
    if (columns.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

function toFiniteNumber(value: number | string | null | undefined): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function toNonNegativeInteger(value: number | string | null | undefined): number {
  return Math.max(0, Math.trunc(toFiniteNumber(value)));
}

export function readContainerEnv(envEntries: string[] | undefined): Record<string, string> {
  const env: Record<string, string> = {};

  for (const entry of envEntries ?? []) {
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    env[entry.slice(0, separatorIndex)] = entry.slice(separatorIndex + 1);
  }

  return env;
}

export function resolveContainerIpAddress(
  inspection: DockerContainerInspection | null
): string | null {
  const networks = inspection?.NetworkSettings?.Networks;
  if (!networks) {
    return null;
  }

  for (const network of Object.values(networks)) {
    if (typeof network?.IPAddress === "string" && network.IPAddress.length > 0) {
      return network.IPAddress;
    }
  }

  return null;
}

function getManagedContainerName(container: ManagedContainerRecord): string | null {
  return container.Names?.[0] ?? null;
}

export function isManagedPostgresContainer(
  container: ManagedContainerRecord,
  inspection: DockerContainerInspection | null
): boolean {
  const labels = {
    ...(container.Labels ?? {}),
    ...(inspection?.Config?.Labels ?? {}),
  };

  if (labels["nouva.kind"] !== "database") {
    return false;
  }

  if (labels["nouva.service.variant"] === "postgres") {
    return true;
  }

  const containerName = inspection?.Name ?? getManagedContainerName(container);
  return (
    typeof containerName === "string" && containerName.startsWith(POSTGRES_CONTAINER_NAME_PREFIX)
  );
}

export function buildManagedPostgresTarget(
  container: ManagedContainerRecord,
  inspection: DockerContainerInspection | null
): ManagedPostgresTarget | null {
  if (!inspection || !isManagedPostgresContainer(container, inspection)) {
    return null;
  }

  const serviceId =
    inspection.Config?.Labels?.["nouva.service.id"] ??
    container.Labels?.["nouva.service.id"] ??
    null;
  const host = resolveContainerIpAddress(inspection);
  const env = readContainerEnv(inspection.Config?.Env);
  const username = env.POSTGRES_USER ?? null;
  const password = env.POSTGRES_PASSWORD ?? null;
  const database = env.POSTGRES_DB ?? "postgres";
  const rawPort = env.POSTGRES_PORT ?? String(POSTGRES_SERVER_PORT_FALLBACK);
  const parsedPort = Number.parseInt(rawPort, 10);
  const port = Number.isFinite(parsedPort) ? parsedPort : POSTGRES_SERVER_PORT_FALLBACK;

  if (!serviceId || !host || !username || !password) {
    return null;
  }

  return {
    serviceId,
    host,
    port,
    username,
    password,
    database,
  };
}

export async function fetchPostgresObservabilitySnapshot(
  target: ManagedPostgresTarget
): Promise<PostgresObservabilitySnapshot> {
  const sql = postgres({
    host: target.host,
    port: target.port,
    database: target.database,
    username: target.username,
    password: target.password,
    ssl: "require",
    connect_timeout: 5,
    idle_timeout: 5,
    max: 1,
    prepare: false,
    onnotice: () => {},
    connection: {
      application_name: "nouva-agent-observability",
    },
  });

  try {
    const extensionRows = await sql<{ extname: string }[]>`
      SELECT extname
      FROM pg_extension
      WHERE extname IN ('pg_stat_monitor', 'pg_cron')
    `;
    const extensionSet = new Set(extensionRows.map((row) => row.extname));

    const columnRows = await sql<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'pg_stat_monitor'
      ORDER BY ordinal_position
    `;

    if (columnRows.length === 0) {
      throw new Error(
        "pg_stat_monitor is not available for this service yet. Restart the service to apply extension bootstrap."
      );
    }

    const columns = new Set(columnRows.map((row) => row.column_name));
    const totalTimeColumn = pickPgStatMonitorColumn(columns, ["total_time", "total_exec_time"]);
    const meanTimeColumn = pickPgStatMonitorColumn(columns, ["mean_time", "mean_exec_time"]);
    const minTimeColumn = pickPgStatMonitorColumn(columns, ["min_time", "min_exec_time"]);
    const maxTimeColumn = pickPgStatMonitorColumn(columns, ["max_time", "max_exec_time"]);

    if (
      !columns.has("queryid") ||
      !columns.has("calls") ||
      !columns.has("rows") ||
      !columns.has("query")
    ) {
      throw new Error("pg_stat_monitor does not expose the expected columns for query insights.");
    }

    if (!totalTimeColumn || !meanTimeColumn || !minTimeColumn || !maxTimeColumn) {
      throw new Error(
        "pg_stat_monitor timing columns are unavailable for this PostgreSQL version."
      );
    }

    const slowQueriesSql = `
      SELECT
        queryid::text AS query_id,
        calls::bigint::text AS calls,
        ${totalTimeColumn}::double precision AS total_time_ms,
        ${meanTimeColumn}::double precision AS mean_time_ms,
        ${minTimeColumn}::double precision AS min_time_ms,
        ${maxTimeColumn}::double precision AS max_time_ms,
        rows::bigint::text AS rows,
        LEFT(REGEXP_REPLACE(query, '\\s+', ' ', 'g'), 2000) AS query_text
      FROM pg_stat_monitor
      WHERE query IS NOT NULL
        AND calls > 0
      ORDER BY ${totalTimeColumn} DESC
      LIMIT ${MAX_SLOW_QUERY_COUNT}
    `;

    const slowQueryRows = await sql.unsafe<SlowQueryRow[]>(slowQueriesSql);
    const activeSessionRows = await sql<{ state: string; count: number }[]>`
      SELECT
        COALESCE(state, 'unknown') AS state,
        count(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
      GROUP BY COALESCE(state, 'unknown')
      ORDER BY count(*) DESC
    `;

    return {
      collectedAt: new Date().toISOString(),
      extensionStatus: {
        pgStatMonitor: extensionSet.has("pg_stat_monitor"),
        pgCron: extensionSet.has("pg_cron"),
      },
      activeSessions: activeSessionRows.map((row) => ({
        state: row.state,
        count: toNonNegativeInteger(row.count),
      })),
      slowQueries: slowQueryRows.map((row) => ({
        queryId: row.query_id ?? "unknown",
        query: row.query_text ?? "",
        calls: toNonNegativeInteger(row.calls),
        rows: toNonNegativeInteger(row.rows),
        totalTimeMs: toFiniteNumber(row.total_time_ms),
        meanTimeMs: toFiniteNumber(row.mean_time_ms),
        minTimeMs: toFiniteNumber(row.min_time_ms),
        maxTimeMs: toFiniteNumber(row.max_time_ms),
      })),
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function createErrorSample(
  serviceId: string,
  errorMessage: string,
  collectedAt: string
): AgentPostgresObservabilitySample {
  return {
    serviceId,
    collectedAt,
    status: "error",
    errorMessage,
    extensionStatus: null,
    activeSessions: null,
    slowQueries: null,
  };
}

export async function collectPostgresObservabilitySamplesWithDependencies(
  docker: DockerApiClient,
  dependencies: {
    fetchSnapshot: (target: ManagedPostgresTarget) => Promise<PostgresObservabilitySnapshot>;
    now: () => string;
  }
): Promise<AgentPostgresObservabilitySample[]> {
  const containers = await docker.listManagedContainers();
  const samples: AgentPostgresObservabilitySample[] = [];

  for (const container of containers) {
    if (container.State !== "running") {
      continue;
    }

    const serviceId = container.Labels?.["nouva.service.id"];
    if (!serviceId) {
      continue;
    }

    const inspection = await docker.inspectContainer(container.Id);
    if (!isManagedPostgresContainer(container, inspection)) {
      continue;
    }

    const target = buildManagedPostgresTarget(container, inspection);
    if (!target) {
      samples.push(
        createErrorSample(
          serviceId,
          "Managed PostgreSQL container is missing connection details.",
          dependencies.now()
        )
      );
      continue;
    }

    try {
      const snapshot = await dependencies.fetchSnapshot(target);
      samples.push({
        serviceId: target.serviceId,
        collectedAt: snapshot.collectedAt,
        status: "success",
        errorMessage: null,
        extensionStatus: snapshot.extensionStatus,
        activeSessions: snapshot.activeSessions,
        slowQueries: snapshot.slowQueries,
      });
    } catch (error) {
      samples.push(
        createErrorSample(
          target.serviceId,
          error instanceof Error ? error.message : "Failed to collect PostgreSQL observability.",
          dependencies.now()
        )
      );
    }
  }

  return samples;
}

export async function collectPostgresObservabilitySamples(
  docker: DockerApiClient
): Promise<AgentPostgresObservabilitySample[]> {
  return await collectPostgresObservabilitySamplesWithDependencies(docker, {
    fetchSnapshot: fetchPostgresObservabilitySnapshot,
    now: () => new Date().toISOString(),
  });
}
