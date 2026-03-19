import type {
  AgentMetricsEnvelope,
  AgentRegistrationSnapshot,
  AgentRuntimeConfig,
  AgentWorkLeaseResult,
} from "./agent.js";

export interface AgentRegistrationRequest extends AgentRegistrationSnapshot {
  registrationToken: string;
}

export interface AgentRegistrationResponse {
  serverId: string;
  agentToken: string;
  config: AgentRuntimeConfig;
}

export type AgentHeartbeatRequest = AgentRegistrationSnapshot;

export interface AgentHeartbeatResponse {
  ok: true;
  config: AgentRuntimeConfig;
}

export interface AgentLeaseRequest {
  serverId: string;
  limit?: number;
}

export type AgentLeaseResponse = AgentWorkLeaseResult;

export interface AgentWorkMutationRequest {
  serverId: string;
  leaseId: string;
  result?: Record<string, unknown> | null;
  errorMessage?: string | null;
}

export interface AgentWorkMutationResponse {
  ok: true;
}

export interface AgentMetricsRequest extends AgentMetricsEnvelope {
  serverId: string;
}

export interface AgentMetricsResponse {
  ok: true;
}

export interface AgentErrorResponse {
  message: string;
}
