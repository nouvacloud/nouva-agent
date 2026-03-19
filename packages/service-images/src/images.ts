import type { ServiceCredentials } from "./credentials.js";

export type ServiceVariant = "postgres" | "redis";

export interface ServiceEnvContext {
  serviceId: string;
  projectId: string;
  volumeId: string;
  dataPath?: string;
  pgBackrestEnv?: Record<string, string>;
}

export interface PgBackrestIdentity {
  stanza: string;
  repo1Path: string;
}

export function getPgBackrestIdentity(options: {
  projectId: string;
  volumeId: string;
}): PgBackrestIdentity {
  return {
    stanza: `vol-${options.volumeId}`,
    repo1Path: `/postgres/v1/projects/${options.projectId}/volumes/${options.volumeId}`,
  };
}

export interface ImageConfig {
  image: string;
  defaultVersion: string;
  supportedVersions: readonly string[];
  defaultPort: number;
  dataPath: string;
  healthCheck: {
    type: "tcp" | "script";
    command?: string;
    args?: string[];
    interval: string;
    timeout: string;
  };
  getEnvVars: (creds: ServiceCredentials, context?: ServiceEnvContext) => Record<string, string>;
  getArgs?: (creds: ServiceCredentials) => string[];
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

export const SERVICE_IMAGES: Record<ServiceVariant, ImageConfig> = {
  postgres: {
    image: getPostgresImage(),
    defaultVersion: "17",
    supportedVersions: ["18", "17", "16", "15"],
    defaultPort: 5432,
    dataPath: "/var/lib/postgresql",
    healthCheck: {
      type: "tcp",
      interval: "10s",
      timeout: "2s",
    },
    getEnvVars: (creds, context) => {
      const base = {
        POSTGRES_USER: creds.username,
        POSTGRES_PASSWORD: creds.password,
        POSTGRES_DB: creds.database ?? "postgres",
        POSTGRES_SOCKET_DIR: "/var/lib/postgresql/.sockets",
      };

      if (!context) {
        return base;
      }

      const pgBackrestEnv = context.pgBackrestEnv ?? {};
      const pgBackrestIdentity = getPgBackrestIdentity({
        projectId: context.projectId,
        volumeId: context.volumeId,
      });

      return {
        ...base,
        ...pgBackrestEnv,
        PGBACKREST_STANZA: pgBackrestIdentity.stanza,
        PGBACKREST_REPO1_PATH: pgBackrestIdentity.repo1Path,
      };
    },
  },
  redis: {
    image: "redis",
    defaultVersion: "7.4",
    supportedVersions: ["7.4", "7.2", "7.0"],
    defaultPort: 6379,
    dataPath: "/data",
    healthCheck: {
      type: "tcp",
      interval: "10s",
      timeout: "2s",
    },
    getEnvVars: () => ({}),
    getArgs: (creds) => ["redis-server", "--requirepass", creds.password],
  },
};

export function getImageConfig(variant: ServiceVariant): ImageConfig {
  const config = SERVICE_IMAGES[variant];
  if (!config) {
    throw new Error(`Unknown service variant: ${variant}`);
  }
  return config;
}

export function isVersionSupported(variant: ServiceVariant, version: string): boolean {
  const config = SERVICE_IMAGES[variant];
  return config?.supportedVersions.includes(version) ?? false;
}

export function getDefaultVersion(variant: ServiceVariant): string {
  const config = SERVICE_IMAGES[variant];
  if (!config) {
    throw new Error(`Unknown service variant: ${variant}`);
  }
  return config.defaultVersion;
}
