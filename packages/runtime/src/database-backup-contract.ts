/**
 * Value shapes shared by the control plane and the agent that carry no ORM types.
 *
 * These live apart from `agent.ts` for one reason: `agent.ts` type-imports `@repo/db/schema`, and
 * some agent-side modules must compile without the ORM on the customer's server. The public agent
 * mirror ships only the runtime files the agent actually imports, so anything reachable from those
 * files has to stay ORM-free — `external-backup-import.ts` is the first module with that
 * constraint, and importing these three interfaces from `agent.ts` would have dragged
 * `@repo/db/schema` into the mirror with them.
 *
 * `agent.ts` re-exports everything here, so this split is invisible to importers.
 */

/** Credentials for the database a provision or restore targets. */
export interface DatabaseProvisionCredentials {
  username: string;
  password: string;
  database?: string;
}

/**
 * Where platform backups are stored, minus the secrets needed to authenticate.
 *
 * This is the half that is safe to persist on a queued work item: secrets are hydrated only when
 * the agent leases the work.
 */
export interface PlatformBackupDestinationMetadata {
  [key: string]: unknown;
  id: string;
  type: "s3";
  bucket: string;
  endpoint: string;
  region: string;
  pathStyle: boolean;
  verifyTls: boolean;
  pgbackrestRepoType: string;
  pgbackrestCipherType: string | null;
  pgbackrestRetentionFullType: string | null;
  pgbackrestRetentionFull: string | null;
  pgbackrestRetentionDiff: string | null;
  pgbackrestRetentionArchiveType: string | null;
  pgbackrestRetentionArchive: string | null;
  pgbackrestRetentionHistory: string | null;
  pgbackrestArchiveAsync: boolean | null;
  pgbackrestSpoolPath: string | null;
}

/** The destination with its secrets attached, as handed to the agent at lease time. */
export interface PlatformBackupDestination extends PlatformBackupDestinationMetadata {
  accessKeyId: string;
  secretAccessKey: string;
  pgbackrestCipherPass: string | null;
}
