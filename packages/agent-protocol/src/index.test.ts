import { afterEach, describe, expect, test } from "bun:test";

import {
	buildLocalHttpRouteConfig,
	canLeaseWorkItem,
	type AgentHeartbeatRequest,
	type AgentHeartbeatResponse,
	type AgentLeaseRequest,
	type AgentLeaseResponse,
	type AgentMetricsRequest,
	type AgentRegistrationRequest,
	type AgentRegistrationResponse,
	type AgentWorkMutationRequest,
	getAgentRuntimeConfig,
	negotiateDockerApiVersion,
	parseHostMetricsSnapshot,
	parseDockerStatsSnapshot,
} from "./index.js";

const runtimeEnvKeys = [
	"NOUVA_AGENT_HEARTBEAT_INTERVAL_SECONDS",
	"NOUVA_AGENT_POLL_INTERVAL_SECONDS",
	"NOUVA_AGENT_LEASE_TTL_SECONDS",
	"NOUVA_AGENT_METRICS_INTERVAL_SECONDS",
	"NOUVA_AGENT_LOCAL_REGISTRY_HOST",
	"NOUVA_AGENT_LOCAL_REGISTRY_PORT",
	"NOUVA_AGENT_INGRESS_NETWORK",
] as const;

const originalRuntimeEnv = Object.fromEntries(
	runtimeEnvKeys.map((key) => [key, process.env[key]]),
) as Record<(typeof runtimeEnvKeys)[number], string | undefined>;

describe("@nouvacloud/agent-protocol", () => {
	afterEach(() => {
		for (const key of runtimeEnvKeys) {
			const value = originalRuntimeEnv[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	test("should serialize the agent wire contract fixtures", () => {
		// Arrange
		const registrationRequest = {
			serverId: "srv_123",
			registrationToken: "reg_123",
			hostname: "host-1",
			operatingSystem: "ubuntu",
			architecture: "x64",
			dockerVersion: "27.0.0",
			agentVersion: "0.1.0",
			publicIp: "203.0.113.10",
			cpuCores: 4,
			memoryBytes: 16_000_000_000,
			diskBytesAvailable: 500_000_000_000,
			latestValidationReport: {
				checkedAt: new Date().toISOString(),
				summary: { pass: 1, warn: 0, fail: 0 },
				checks: [
					{ key: "docker", label: "Docker", status: "pass", message: "ok" },
				],
			},
			capabilities: {
				dockerApi: true,
			},
		} satisfies AgentRegistrationRequest;

		const registrationResponse = {
			serverId: "srv_123",
			agentToken: "agent_123",
			config: getAgentRuntimeConfig(),
		} satisfies AgentRegistrationResponse;

		const heartbeatRequest = {
			...registrationRequest,
		} satisfies AgentHeartbeatRequest;

		const heartbeatResponse = {
			ok: true,
			config: getAgentRuntimeConfig(),
		} satisfies AgentHeartbeatResponse;

		const leaseRequest = {
			serverId: "srv_123",
			limit: 5,
		} satisfies AgentLeaseRequest;

		const leaseResponse = {
			config: getAgentRuntimeConfig(),
			workItems: [],
		} satisfies AgentLeaseResponse;

		const mutationRequest = {
			serverId: "srv_123",
			leaseId: "lease_123",
			result: { ok: true },
			errorMessage: null,
		} satisfies AgentWorkMutationRequest;

		const metricsRequest = {
			serverId: "srv_123",
			server: {
				collectedAt: new Date().toISOString(),
			},
			services: [],
		} satisfies AgentMetricsRequest;

		// Act
		const roundTrips = [
			registrationRequest,
			registrationResponse,
			heartbeatRequest,
			heartbeatResponse,
			leaseRequest,
			leaseResponse,
			mutationRequest,
			metricsRequest,
		].map((value) => JSON.parse(JSON.stringify(value)));

		// Assert
		expect(roundTrips).toHaveLength(8);
		expect(roundTrips[0]).toEqual(registrationRequest);
		expect(roundTrips[7]).toEqual(metricsRequest);
	});

	test("should use queued and expired work items as leaseable", () => {
		// Arrange
		const queued = {
			status: "queued" as const,
			leaseExpiresAt: null,
		};
		const expired = {
			status: "leased" as const,
			leaseExpiresAt: new Date(Date.now() - 1_000),
		};
		const active = {
			status: "leased" as const,
			leaseExpiresAt: new Date(Date.now() + 1_000),
		};

		// Act
		const queuedLeaseable = canLeaseWorkItem(queued);
		const expiredLeaseable = canLeaseWorkItem(expired);
		const activeLeaseable = canLeaseWorkItem(active);

		// Assert
		expect(queuedLeaseable).toBe(true);
		expect(expiredLeaseable).toBe(true);
		expect(activeLeaseable).toBe(false);
	});

	test("should render local traefik route config", () => {
		// Arrange
		const config = buildLocalHttpRouteConfig({
			fileKey: "svc-1",
			hostnames: ["app.example.com"],
			serviceUrl: "http://127.0.0.1:3000",
		});

		// Assert
		expect(config).toContain("Host(`app.example.com`)");
		expect(config).toContain("http://127.0.0.1:3000");
	});

	test("should parse docker stats snapshots", () => {
		// Arrange
		const stats = {
			cpu_stats: {
				cpu_usage: {
					total_usage: 200,
					percpu_usage: [100, 100],
				},
				system_cpu_usage: 10_000,
				online_cpus: 2,
			},
			precpu_stats: {
				cpu_usage: {
					total_usage: 100,
				},
				system_cpu_usage: 5_000,
			},
			memory_stats: {
				usage: 128,
				limit: 512,
			},
			networks: {
				eth0: {
					rx_bytes: 10,
					tx_bytes: 20,
				},
			},
			blkio_stats: {
				io_service_bytes_recursive: [
					{ op: "Read", value: 30 },
					{ op: "Write", value: 40 },
				],
			},
			pids_stats: {
				current: 3,
			},
		};

		// Act
		const parsed = parseDockerStatsSnapshot(stats);

		// Assert
		expect(parsed.cpuUsageBasisPoints).toBe(400);
		expect(parsed.memoryUsageBytes).toBe(128);
		expect(parsed.networkRxBytes).toBe(10);
		expect(parsed.blockWriteBytes).toBe(40);
		expect(negotiateDockerApiVersion({ ApiVersion: "1.47" })).toBe("v1.47");
	});

	test("should read runtime config from env overrides and fallback invalid registry port", () => {
		// Arrange
		process.env.NOUVA_AGENT_HEARTBEAT_INTERVAL_SECONDS = "45";
		process.env.NOUVA_AGENT_POLL_INTERVAL_SECONDS = "12";
		process.env.NOUVA_AGENT_LEASE_TTL_SECONDS = "240";
		process.env.NOUVA_AGENT_METRICS_INTERVAL_SECONDS = "90";
		process.env.NOUVA_AGENT_LOCAL_REGISTRY_HOST = "registry.internal";
		process.env.NOUVA_AGENT_LOCAL_REGISTRY_PORT = "not-a-number";
		process.env.NOUVA_AGENT_INGRESS_NETWORK = "nouva-public";

		// Act
		const config = getAgentRuntimeConfig();

		// Assert
		expect(config.heartbeatIntervalSeconds).toBe(45);
		expect(config.pollIntervalSeconds).toBe(12);
		expect(config.leaseTtlSeconds).toBe(240);
		expect(config.metricsIntervalSeconds).toBe(90);
		expect(config.localRegistryHost).toBe("registry.internal");
		expect(config.localRegistryPort).toBe(5000);
		expect(config.localTraefikNetwork).toBe("nouva-public");
		expect(config.capabilities).toEqual(
			expect.objectContaining({
				dockerApi: true,
				buildkit: true,
				localRegistry: true,
			}),
		);
	});

	test("should parse host metrics snapshots with cpu, memory, disk, and load data", () => {
		// Arrange
		const snapshot = {
			currentCpuStat:
				"cpu  150 0 150 900 0 0 0 0 0 0\ncpu0 75 0 75 450 0 0 0 0 0 0",
			previousCpuStat:
				"cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0 0 0",
			meminfo: "MemTotal: 2048 kB\nMemAvailable: 512 kB\n",
			loadavg: "0.12 1.50 10.01 1/123 456",
			diskAvailableBytes: 250,
			diskTotalBytes: 1000,
		};

		// Act
		const parsed = parseHostMetricsSnapshot(snapshot);

		// Assert
		expect(parsed.cpuUsageBasisPoints).toBe(5000);
		expect(parsed.memoryTotalBytes).toBe(2_097_152);
		expect(parsed.memoryUsedBytes).toBe(1_572_864);
		expect(parsed.diskAvailableBytes).toBe(250);
		expect(parsed.diskUsedBytes).toBe(750);
		expect(parsed.loadAvg1mMilli).toBe(120);
		expect(parsed.loadAvg5mMilli).toBe(1500);
		expect(parsed.loadAvg15mMilli).toBe(10010);
		expect(parsed.raw).toBeNull();
		expect(Number.isNaN(Date.parse(parsed.collectedAt))).toBe(false);
	});
});
