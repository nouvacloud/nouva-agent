import type {
  AgentHeartbeatRequest,
  AgentHeartbeatResponse,
  AgentRuntimeConfig,
} from "./protocol.js";

type HeartbeatSnapshot = Omit<AgentHeartbeatRequest, "serverId" | "agentVersion">;

export interface AgentHeartbeatDependencies {
  /** Validation also retries reconciliation of the currently adopted runtime config. */
  collectSnapshot: (config: AgentRuntimeConfig) => Promise<HeartbeatSnapshot>;
  request: (snapshot: HeartbeatSnapshot, signal?: AbortSignal) => Promise<Response>;
  /** Enforces the single-use registration token and adopts credentials in place. */
  reregister: (config: AgentRuntimeConfig, signal?: AbortSignal) => Promise<AgentRuntimeConfig>;
  reloadRedactionContext: (next: AgentRuntimeConfig, previous: AgentRuntimeConfig) => Promise<void>;
  /** Uses the same serialized runtime queue as validation, deploys and routing work. */
  reconcileTraefik: (config: AgentRuntimeConfig) => Promise<void>;
}

/**
 * Applies changed forwarding trust before returning a successful response's config. Runtime
 * failures are best effort: adopt the config and let validation retry on following heartbeats.
 * Transport/registration failures remain heartbeat failures.
 */
export async function sendAgentHeartbeat(
  dependencies: AgentHeartbeatDependencies,
  config: AgentRuntimeConfig,
  signal?: AbortSignal
): Promise<AgentRuntimeConfig> {
  const snapshot = await dependencies.collectSnapshot(config);
  const response = await dependencies.request(snapshot, signal);

  let next: AgentRuntimeConfig;
  if (response.status === 401) {
    next = await dependencies.reregister(config, signal);
  } else {
    if (!response.ok) {
      throw new Error(`Heartbeat failed with status ${response.status}`);
    }
    const body = (await response.json()) as AgentHeartbeatResponse;
    next = body.config;
    await dependencies.reloadRedactionContext(next, config);
  }

  if (
    JSON.stringify(next.trustedForwardedPeers ?? []) !==
    JSON.stringify(config.trustedForwardedPeers ?? [])
  ) {
    try {
      await dependencies.reconcileTraefik(next);
    } catch {
      // Adopt the response even on failure. Every subsequent validation retries the adopted
      // config, including updates delivered by work leasing, without another peer change.
      console.error("[nouva-agent] Traefik trust reload failed; validation will retry");
    }
  }
  return next;
}
