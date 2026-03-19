import type { DatabaseProvisionPayload } from "./protocol.js";

export interface ServiceCredentials {
  username: string;
  password: string;
  database?: string;
}

type ServiceVariant = "postgres" | "redis";

interface ServiceEnvContext {
  projectId: string;
  volumeId: string;
}

interface LegacyImageConfig {
  image: string;
  defaultPort: number;
  dataPath: string;
  getEnvVars: (creds: ServiceCredentials, context: ServiceEnvContext) => Record<string, string>;
  getArgs?: (creds: ServiceCredentials) => string[];
}

interface ResolvedDatabaseProvisionSpec {
  image: string;
  envVars: Record<string, string>;
  containerArgs: string[];
  dataPath: string;
  internalPort: number;
}

type DatabaseProvisionExecutorPayload = DatabaseProvisionPayload & {
  imageUrl: string;
  envVars: Record<string, unknown>;
  containerArgs: unknown[];
  dataPath: string;
};

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

function resolveImage(image: string): string {
  const registry = process.env.NOUVA_IMAGE_REGISTRY?.replace(/\/$/, "") ?? "";
  if (!registry) {
    return image;
  }

  return `${registry}/${image}`;
}

function getPostgresImage(): string {
  const override = process.env.NOUVA_POSTGRES_IMAGE;
  if (override) {
    return override;
  }

  return resolveImage("postgres");
}

export function getLegacyPgBackrestIdentity(options: {
  projectId: string;
  volumeId: string;
}): {
  stanza: string;
  repo1Path: string;
} {
  return {
    stanza: `vol-${options.volumeId}`,
    repo1Path: `/postgres/v1/projects/${options.projectId}/volumes/${options.volumeId}`,
  };
}

function hasExplicitImageVersion(image: string): boolean {
  return image.includes("@") || image.lastIndexOf(":") > image.lastIndexOf("/");
}

function formatImageReference(image: string, version: string): string {
  return hasExplicitImageVersion(image) ? image : `${image}:${version}`;
}

function getLegacyImageConfig(variant: ServiceVariant): LegacyImageConfig {
  switch (variant) {
    case "postgres":
      return {
        image: getPostgresImage(),
        defaultPort: 5432,
        dataPath: "/var/lib/postgresql",
        getEnvVars: (creds, context) => {
          const identity = getLegacyPgBackrestIdentity(context);
          return {
            POSTGRES_USER: creds.username,
            POSTGRES_PASSWORD: creds.password,
            POSTGRES_DB: creds.database ?? "postgres",
            POSTGRES_SOCKET_DIR: "/var/lib/postgresql/.sockets",
            PGBACKREST_STANZA: identity.stanza,
            PGBACKREST_REPO1_PATH: identity.repo1Path,
          };
        },
      };
    case "redis":
      return {
        image: resolveImage("redis"),
        defaultPort: 6379,
        dataPath: "/data",
        getEnvVars: () => ({}),
        getArgs: (creds) => ["redis-server", "--requirepass", creds.password],
      };
    default:
      throw new Error(`Unsupported database variant: ${variant}`);
  }
}

function hasExecutorFields(payload: DatabaseProvisionPayload): payload is DatabaseProvisionExecutorPayload {
  return (
    typeof payload.imageUrl === "string" &&
    payload.imageUrl.length > 0 &&
    typeof payload.dataPath === "string" &&
    payload.dataPath.length > 0 &&
    typeof payload.envVars === "object" &&
    payload.envVars !== null &&
    Array.isArray(payload.containerArgs)
  );
}

export function resolveDatabaseProvisionSpec(
  payload: DatabaseProvisionPayload
): ResolvedDatabaseProvisionSpec {
  if (hasExecutorFields(payload)) {
    return {
      image: payload.imageUrl,
      envVars: toRecord(payload.envVars),
      containerArgs: payload.containerArgs.filter(
        (value): value is string => typeof value === "string"
      ),
      dataPath: payload.dataPath,
      internalPort: payload.internalPort,
    };
  }

  if (!payload.version || !payload.credentials) {
    throw new Error("Database payload is missing executor fields and legacy fallback data");
  }

  const config = getLegacyImageConfig(payload.variant);
  const volumeName = `nouva-vol-${payload.serviceId.slice(0, 12)}`;
  const credentials = toServiceCredentials(payload.credentials);

  return {
    image: formatImageReference(config.image, payload.version),
    envVars: config.getEnvVars(credentials, {
      projectId: payload.projectId,
      volumeId: volumeName,
    }),
    containerArgs: config.getArgs?.(credentials) ?? [],
    dataPath: config.dataPath,
    internalPort: payload.internalPort || config.defaultPort,
  };
}
