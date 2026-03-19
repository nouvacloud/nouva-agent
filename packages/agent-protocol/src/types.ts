export const SERVER_CHECK_STATUSES = ["pass", "warn", "fail"] as const;
export type ServerCheckStatus = (typeof SERVER_CHECK_STATUSES)[number];

export const AGENT_WORK_STATUSES = [
  "queued",
  "leased",
  "completed",
  "failed",
  "cancelled",
] as const;
export type AgentWorkStatus = (typeof AGENT_WORK_STATUSES)[number];

export const AGENT_WORK_KINDS = [
  "deploy_app",
  "redeploy_app",
  "rollback_app",
  "restart_app",
  "remove_app",
  "provision_database",
  "restart_database",
  "delete_service",
  "sync_routing",
  "update_agent",
] as const;
export type AgentWorkKind = (typeof AGENT_WORK_KINDS)[number];

export type ServerValidationCheck = {
  key: string;
  label: string;
  status: ServerCheckStatus;
  message: string;
  value?: string | null;
};

export type ServerValidationReport = {
  checkedAt: string;
  summary: {
    pass: number;
    warn: number;
    fail: number;
  };
  checks: ServerValidationCheck[];
};

export type RuntimeMetadata = {
  configVersion?: number;
  ingressHost?: string | null;
  ingressPort?: number | null;
  publishedPort?: number | null;
  image?: string | null;
  containerId?: string | null;
  containerName?: string | null;
  networkName?: string | null;
  runtimeInstanceId?: string | null;
  [key: string]: unknown;
};

export type AgentCapabilities = {
  dockerApi?: boolean;
  buildkit?: boolean;
  localRegistry?: boolean;
  localTraefik?: boolean;
  hostMetrics?: boolean;
  containerMetrics?: boolean;
  [key: string]: boolean | undefined;
};
