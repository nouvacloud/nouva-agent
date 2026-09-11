import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type AgentHeartbeatDependencies, sendAgentHeartbeat } from "./agent-heartbeat.js";
import type { DockerContainerInspection, DockerContainerSpec } from "./docker-api.js";
import { type AgentRuntimeConfig, getAgentRuntimeConfig } from "./protocol.js";
import { createSerializedTaskRunner } from "./serialized-task.js";
import {
  createTraefikStateHash,
  ensureTraefikRuntime,
  getTraefikRuntimePaths,
  renderTraefikStaticConfig,
  resetTraefikRuntimeState,
  TRAEFIK_CONFIG_HASH_LABEL,
  TRAEFIK_CONTAINER_NAME,
  TRAEFIK_IMAGE,
} from "./traefik-runtime.js";

const oldPeers = ["192.0.2.10/32"];
const newPeers = ["192.0.2.20/32"];
const directories: string[] = [];

afterEach(async () => {
  mock.restore();
  resetTraefikRuntimeState();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function heartbeatFixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "nouva-heartbeat-"));
  directories.push(dataDir);
  const paths = getTraefikRuntimePaths(dataDir);
  const initialConfig: AgentRuntimeConfig = {
    ...getAgentRuntimeConfig(),
    trustedForwardedPeers: oldPeers,
  };
  let responseConfig: AgentRuntimeConfig = { ...initialConfig, trustedForwardedPeers: newPeers };
  const containers = new Map<string, DockerContainerInspection>();
  const docker = {
    ensureNetwork: mock(async () => {}),
    listNetworks: mock(async () => []),
    connectNetwork: mock(async () => {}),
    pullImage: mock(async () => {}),
    inspectContainer: mock(async (name: string) => containers.get(name) ?? null),
    removeContainer: mock(async (name: string) => {
      containers.delete(name);
    }),
    ensureContainer: mock(async (spec: DockerContainerSpec) => {
      containers.set(spec.name, {
        Id: spec.name,
        Name: spec.name,
        State: { Running: true },
        Config: { Image: spec.image, Labels: spec.labels },
        HostConfig: spec.hostConfig as DockerContainerInspection["HostConfig"],
      });
      return spec.name;
    }),
  };
  const tasks = createSerializedTaskRunner();
  const reconcile = (config: AgentRuntimeConfig) =>
    tasks.run(() =>
      ensureTraefikRuntime(
        docker as never,
        {
          dataDir,
          dataVolume: "nouva-agent-data",
          containerName: TRAEFIK_CONTAINER_NAME,
          networkName: config.localTraefikNetwork,
          serverId: "server-1",
          image: TRAEFIK_IMAGE,
          trustedForwardedPeers: config.trustedForwardedPeers,
        },
        {
          paths,
          fetchImpl: mock(async (input: RequestInfo | URL) =>
            String(input).endsWith("/ping") ? new Response("OK") : Response.json([])
          ) as typeof fetch,
          timeoutMs: 200,
          intervalMs: 1,
        }
      )
    );
  await reconcile(initialConfig);
  docker.ensureContainer.mockClear();
  docker.removeContainer.mockClear();
  const liveHash = () =>
    containers.get(TRAEFIK_CONTAINER_NAME)?.Config?.Labels?.[TRAEFIK_CONFIG_HASH_LABEL];
  const hashFor = (peers: string[]) =>
    createTraefikStateHash(renderTraefikStaticConfig(paths, peers));
  const hashesAtRequest: (string | undefined)[] = [];
  const validationFailures: unknown[] = [];
  const dependencies: AgentHeartbeatDependencies = {
    collectSnapshot: mock(async (config) => {
      // The production validation snapshot reports reconcile failures, but still sends liveness.
      try {
        await reconcile(config);
      } catch (error) {
        validationFailures.push(error);
      }
      return {
        hostname: "test-server",
        operatingSystem: null,
        architecture: null,
        dockerVersion: "27.0",
        publicIp: null,
        cpuCores: null,
        memoryBytes: null,
        diskBytesAvailable: null,
        diskTotalBytes: null,
        latestValidationReport: null,
      };
    }),
    request: mock(async () => {
      hashesAtRequest.push(liveHash());
      return Response.json({ ok: true, config: responseConfig });
    }),
    reregister: mock(async () => responseConfig),
    reloadRedactionContext: mock(async () => {}),
    reconcileTraefik: reconcile,
  };
  return {
    dependencies,
    initialConfig,
    docker,
    reconcile,
    liveHash,
    hashFor,
    hashesAtRequest,
    paths,
    validationFailures,
    respondWith: (config: AgentRuntimeConfig) => {
      responseConfig = config;
    },
  };
}

describe("agent heartbeat trust propagation", () => {
  test.each([
    { peers: [] },
    { peers: ["192.0.2.10/32", "192.0.2.20/32"] },
  ])("applies peer removal or addition without unrelated work: %j", async ({ peers }) => {
    const fixture = await heartbeatFixture();
    fixture.respondWith({ ...fixture.initialConfig, trustedForwardedPeers: peers });
    await sendAgentHeartbeat(fixture.dependencies, fixture.initialConfig);
    expect(fixture.liveHash()).toBe(fixture.hashFor(peers));
    const rendered = await readFile(fixture.paths.staticConfigPath, "utf8");
    if (peers.length === 0) {
      expect(rendered).not.toContain("trustedIPs:");
      expect(rendered).not.toContain("192.0.2.10/32");
    } else {
      for (const peer of peers) expect(rendered).toContain(peer);
    }
  });

  test("omitted peers clear old trust and remain equivalent to an empty list", async () => {
    const fixture = await heartbeatFixture();
    fixture.respondWith({ ...fixture.initialConfig, trustedForwardedPeers: undefined });
    const adopted = await sendAgentHeartbeat(fixture.dependencies, fixture.initialConfig);
    expect(fixture.liveHash()).toBe(fixture.hashFor([]));
    fixture.docker.ensureContainer.mockClear();
    fixture.docker.removeContainer.mockClear();
    fixture.respondWith({ ...adopted, trustedForwardedPeers: [] });
    await sendAgentHeartbeat(fixture.dependencies, adopted);
    expect(fixture.docker.ensureContainer).not.toHaveBeenCalled();
    expect(fixture.docker.removeContainer).not.toHaveBeenCalled();
  });

  test("passes both configs to redaction reload even when forwarding peers do not change", async () => {
    const fixture = await heartbeatFixture();
    const next: AgentRuntimeConfig = {
      ...fixture.initialConfig,
      observability: {
        ...fixture.initialConfig.observability,
        enabled: true,
        redactionContextVersion: "new-version",
        redactionContextScopeVersions: [
          { kind: "deployment", id: "deployment-1", version: "scope-version" },
        ],
      },
    };
    fixture.respondWith(next);
    const adopted = await sendAgentHeartbeat(fixture.dependencies, fixture.initialConfig);
    expect(fixture.dependencies.reloadRedactionContext).toHaveBeenCalledWith(
      next,
      fixture.initialConfig
    );
    expect(adopted.observability).toEqual(next.observability);
    expect(fixture.docker.ensureContainer).not.toHaveBeenCalled();
  });

  test("unchanged peers do not restart Traefik, including after a successful change", async () => {
    const fixture = await heartbeatFixture();
    fixture.respondWith({ ...fixture.initialConfig, trustedForwardedPeers: [...oldPeers] });
    await sendAgentHeartbeat(fixture.dependencies, fixture.initialConfig);
    expect(fixture.docker.ensureContainer).not.toHaveBeenCalled();
    expect(fixture.docker.removeContainer).not.toHaveBeenCalled();
    fixture.respondWith({ ...fixture.initialConfig, trustedForwardedPeers: newPeers });
    const adopted = await sendAgentHeartbeat(fixture.dependencies, fixture.initialConfig);
    fixture.docker.ensureContainer.mockClear();
    fixture.docker.removeContainer.mockClear();
    await sendAgentHeartbeat(fixture.dependencies, adopted);
    expect(fixture.docker.ensureContainer).not.toHaveBeenCalled();
    expect(fixture.docker.removeContainer).not.toHaveBeenCalled();
  });

  test("adopts config despite failed reload and keeps retrying on validation without losing liveness", async () => {
    const fixture = await heartbeatFixture();
    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("sensitive pull error");
    fixture.docker.pullImage.mockRejectedValueOnce(failure).mockRejectedValueOnce(failure);
    const adopted = await sendAgentHeartbeat(fixture.dependencies, fixture.initialConfig);
    expect(adopted.trustedForwardedPeers).toEqual(newPeers);
    expect(fixture.liveHash()).toBe(fixture.hashFor(oldPeers));
    expect(errorLog.mock.calls).toEqual([
      ["[nouva-agent] Traefik trust reload failed; validation will retry"],
    ]);
    await sendAgentHeartbeat(fixture.dependencies, adopted);
    expect(fixture.liveHash()).toBe(fixture.hashFor(oldPeers));
    expect(fixture.validationFailures).toEqual([failure]);
    await sendAgentHeartbeat(fixture.dependencies, adopted);
    expect(fixture.liveHash()).toBe(fixture.hashFor(newPeers));
    expect(fixture.dependencies.request).toHaveBeenCalledTimes(3);
    expect(fixture.dependencies.reloadRedactionContext).toHaveBeenCalledTimes(3);
  });

  test("a failed lease-delivered peer removal retries even when heartbeat peers are unchanged", async () => {
    const fixture = await heartbeatFixture();
    const leasedConfig = { ...fixture.initialConfig, trustedForwardedPeers: [] };
    fixture.respondWith(leasedConfig);
    fixture.docker.pullImage.mockRejectedValueOnce(new Error("temporary image failure"));
    const adopted = await sendAgentHeartbeat(fixture.dependencies, leasedConfig);
    expect(fixture.liveHash()).toBe(fixture.hashFor(oldPeers));
    await sendAgentHeartbeat(fixture.dependencies, adopted);
    expect(fixture.liveHash()).toBe(fixture.hashFor([]));
    expect(fixture.dependencies.request).toHaveBeenCalledTimes(2);
  });

  test("serializes a heartbeat reload with later routing reconciliation without stale final trust", async () => {
    const fixture = await heartbeatFixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    fixture.docker.pullImage.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    const heartbeat = sendAgentHeartbeat(fixture.dependencies, fixture.initialConfig);
    await entered.promise;
    const routing = fixture.reconcile({ ...fixture.initialConfig, trustedForwardedPeers: [] });
    try {
      expect(fixture.docker.removeContainer).not.toHaveBeenCalled();
      expect(fixture.liveHash()).toBe(fixture.hashFor(oldPeers));
    } finally {
      release.resolve();
      await Promise.all([heartbeat, routing]);
    }
    expect(fixture.liveHash()).toBe(fixture.hashFor([]));
    expect(await readFile(fixture.paths.staticConfigPath, "utf8")).not.toContain("trustedIPs:");
  });

  test("401 re-registration receives the signal and reconciles its returned peers", async () => {
    const fixture = await heartbeatFixture();
    const signal = new AbortController().signal;
    fixture.dependencies.request = mock(async () => new Response(null, { status: 401 }));
    const adopted = await sendAgentHeartbeat(fixture.dependencies, fixture.initialConfig, signal);
    expect(fixture.dependencies.reregister).toHaveBeenCalledWith(fixture.initialConfig, signal);
    expect(adopted.trustedForwardedPeers).toEqual(newPeers);
    expect(fixture.liveHash()).toBe(fixture.hashFor(newPeers));
    // Registration already remembers scope versions; the heartbeat-specific reload stays skipped.
    expect(fixture.dependencies.reloadRedactionContext).not.toHaveBeenCalled();
  });

  test("re-registration rejection remains a heartbeat failure", async () => {
    const fixture = await heartbeatFixture();
    fixture.dependencies.request = mock(async () => new Response(null, { status: 401 }));
    fixture.dependencies.reregister = mock(async () => {
      throw new Error("Agent credentials were rejected. Reinstall the agent.");
    });
    await expect(sendAgentHeartbeat(fixture.dependencies, fixture.initialConfig)).rejects.toThrow(
      "Agent credentials were rejected. Reinstall the agent."
    );
    expect(fixture.liveHash()).toBe(fixture.hashFor(oldPeers));
  });

  test("HTTP and aborted requests remain failures and do not adopt or reload response config", async () => {
    const fixture = await heartbeatFixture();
    fixture.dependencies.request = mock(async () => new Response(null, { status: 503 }));
    await expect(sendAgentHeartbeat(fixture.dependencies, fixture.initialConfig)).rejects.toThrow(
      "Heartbeat failed with status 503"
    );
    const controller = new AbortController();
    controller.abort();
    fixture.dependencies.request = mock(async (_snapshot, signal) => {
      signal?.throwIfAborted();
      throw new Error("Expected aborted request");
    });
    await expect(
      sendAgentHeartbeat(fixture.dependencies, fixture.initialConfig, controller.signal)
    ).rejects.toThrow();
    expect(fixture.dependencies.request).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: "test-server" }),
      controller.signal
    );
    expect(fixture.dependencies.reloadRedactionContext).not.toHaveBeenCalled();
    expect(fixture.liveHash()).toBe(fixture.hashFor(oldPeers));
  });

  test("applies received peers to live Traefik in the same successful heartbeat", async () => {
    const fixture = await heartbeatFixture();
    const adopted = await sendAgentHeartbeat(fixture.dependencies, fixture.initialConfig);
    expect(adopted.trustedForwardedPeers).toEqual(newPeers);
    expect(fixture.liveHash()).toBe(fixture.hashFor(newPeers));
    expect(await readFile(fixture.paths.staticConfigPath, "utf8")).toContain("192.0.2.20/32");
    expect(await readFile(fixture.paths.staticConfigPath, "utf8")).not.toContain("192.0.2.10/32");
  });

  test("validation reconciles adopted config before sending each heartbeat, including lease config", async () => {
    const fixture = await heartbeatFixture();
    const next = await sendAgentHeartbeat(fixture.dependencies, fixture.initialConfig);
    expect(fixture.hashesAtRequest).toEqual([fixture.hashFor(oldPeers)]);
    await sendAgentHeartbeat(fixture.dependencies, next);
    expect(fixture.hashesAtRequest).toEqual([fixture.hashFor(oldPeers), fixture.hashFor(newPeers)]);
    const leasedConfig = { ...next, trustedForwardedPeers: [] };
    fixture.respondWith(leasedConfig);
    await sendAgentHeartbeat(fixture.dependencies, leasedConfig);
    expect(fixture.hashesAtRequest.at(-1)).toBe(fixture.hashFor([]));
    expect(fixture.liveHash()).toBe(fixture.hashFor([]));
  });
});
