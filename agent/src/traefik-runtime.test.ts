import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { DockerContainerInspection } from "./docker-api.js";
import type { AgentRuntimeConfig } from "./protocol.js";
import {
  buildTraefikContainerSpec,
  buildTraefikRouteConfig,
  collectTraefikValidationChecks,
  createTraefikStateHash,
  ensureTraefikState,
  getTraefikRuntimePaths,
  reconcileTraefikRuntime,
  renderTraefikStaticConfig,
  resetTraefikRuntimeState,
  resolveRoutingHostnames,
  TRAEFIK_ADMIN_PORT,
  TRAEFIK_API_ENTRYPOINT,
  TRAEFIK_CANDIDATE_ADMIN_PORT,
  TRAEFIK_CANDIDATE_CONTAINER_NAME,
  TRAEFIK_CONFIG_HASH_LABEL,
  TRAEFIK_CONTAINER_NAME,
  TRAEFIK_IMAGE,
  writeTraefikRouteFile,
} from "./traefik-runtime.js";

const runtimeConfig: AgentRuntimeConfig = {
  heartbeatIntervalSeconds: 30,
  pollIntervalSeconds: 10,
  leaseTtlSeconds: 120,
  metricsIntervalSeconds: 30,
  postgresObservabilityIntervalSeconds: 30,
  ingressMode: "local_traefik",
  buildkitMode: "docker-container",
  capabilities: {
    dockerApi: true,
    buildkit: true,
    localRegistry: true,
    localTraefik: true,
  },
  localRegistryHost: "127.0.0.1",
  localRegistryPort: 5000,
  localTraefikNetwork: "nouva-ingress",
};

function createTraefikInspection(input: {
  name?: string;
  image?: string;
  running?: boolean;
  stateHash?: string;
  port80?: boolean;
  port443?: boolean;
  adminPort?: number;
}): DockerContainerInspection {
  return {
    Id: input.name ?? TRAEFIK_CONTAINER_NAME,
    Name: input.name ?? TRAEFIK_CONTAINER_NAME,
    State: {
      Running: input.running ?? true,
    },
    HostConfig: {
      PortBindings: {
        ...(input.port80 === false
          ? {}
          : {
              "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "80" }],
            }),
        ...(input.port443 === false
          ? {}
          : {
              "443/tcp": [{ HostIp: "0.0.0.0", HostPort: "443" }],
            }),
        "8082/tcp": [
          {
            HostIp: "127.0.0.1",
            HostPort: String(input.adminPort ?? TRAEFIK_ADMIN_PORT),
          },
        ],
      },
    },
    Config: {
      Image: input.image ?? TRAEFIK_IMAGE,
      Labels: {
        [TRAEFIK_CONFIG_HASH_LABEL]: input.stateHash ?? "state-hash",
      },
    },
  };
}

describe("traefik-runtime", () => {
  let tempDir = "";

  afterEach(async () => {
    resetTraefikRuntimeState();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  test("should normalize hostnames from provided and custom routing payloads", () => {
    expect(
      resolveRoutingHostnames({
        providedHostname: "Frontend.UP.Nouva.Cloud",
        customHostnames: ["app.example.com", " frontend.up.nouva.cloud ", "docs.example.com"],
      })
    ).toEqual(["frontend.up.nouva.cloud", "app.example.com", "docs.example.com"]);
  });

  test("should render redirect and TLS routers for file-provider configs", () => {
    const config = buildTraefikRouteConfig({
      fileKey: "svc_1",
      hostnames: ["frontend.up.nouva.cloud", "app.example.com"],
      serviceUrl: "http://nouva-app:3000",
    });

    expect(config).toContain("middlewares:");
    expect(config).toContain("redirectScheme:");
    expect(config).toContain("certResolver: letsencrypt");
    expect(config).toContain("Host(`frontend.up.nouva.cloud`) || Host(`app.example.com`)");
  });

  test("should keep provided hostnames on plain HTTP for hosted edge routing", () => {
    const config = buildTraefikRouteConfig({
      fileKey: "svc_1",
      providedHostnames: ["frontend.up.nouva.cloud"],
      serviceUrl: "http://nouva-app:3000",
    });

    expect(config).toContain("Host(`frontend.up.nouva.cloud`)");
    expect(config).toContain("- web");
    expect(config).not.toContain("- websecure");
    expect(config).not.toContain("certResolver: letsencrypt");
    expect(config).not.toContain("redirectScheme:");
  });

  test("should pin Traefik v3.5 and bind 80, 443, and localhost 8082", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-traefik-"));
    const paths = getTraefikRuntimePaths(tempDir);
    await ensureTraefikState(paths);

    const staticConfig = renderTraefikStaticConfig(paths);
    const spec = buildTraefikContainerSpec(runtimeConfig, {
      dataVolume: "nouva-agent-data",
      stateHash: createTraefikStateHash(staticConfig),
    });

    expect(staticConfig).toContain('address: ":80"');
    expect(staticConfig).toContain('address: ":443"');
    expect(staticConfig).toContain('address: ":8082"');
    expect(staticConfig).toContain(`entryPoint: ${TRAEFIK_API_ENTRYPOINT}`);
    expect(staticConfig).toContain(`  ${TRAEFIK_API_ENTRYPOINT}:`);
    expect(spec.image).toBe("traefik:v3.5");
    expect(spec.hostConfig).toEqual(
      expect.objectContaining({
        PortBindings: expect.objectContaining({
          "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "80" }],
          "443/tcp": [{ HostIp: "0.0.0.0", HostPort: "443" }],
          "8082/tcp": [{ HostIp: "127.0.0.1", HostPort: "8082" }],
        }),
      })
    );
  });

  test("should persist static, dynamic, and acme state with 0600 ACME mode", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-traefik-"));
    const paths = getTraefikRuntimePaths(tempDir);
    await ensureTraefikState(paths);

    const acmeContent = await readFile(paths.acmeStoragePath, "utf8");
    const acmeStats = await stat(paths.acmeStoragePath);

    expect(acmeContent).toBe("{}\n");
    expect(acmeStats.mode & 0o777).toBe(0o600);
  });

  test("should roll back to the previous image when cutover health checks fail", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-traefik-"));
    const paths = getTraefikRuntimePaths(tempDir);
    await ensureTraefikState(paths);
    await writeTraefikRouteFile(paths, "svc_1", ["frontend.up.nouva.cloud"], "http://svc_1:3000");

    const staticConfig = renderTraefikStaticConfig(paths);
    const stateHash = createTraefikStateHash(staticConfig);
    const dockerState: Record<string, DockerContainerInspection | null> = {
      [TRAEFIK_CONTAINER_NAME]: createTraefikInspection({
        image: "traefik:v3.4",
        stateHash,
      }),
    };

    const docker = {
      ensureNetwork: mock(async () => {}),
      pullImage: mock(async () => {}),
      removeContainer: mock(async (name: string) => {
        dockerState[name] = null;
      }),
      inspectContainer: mock(async (name: string) => dockerState[name] ?? null),
      ensureContainer: mock(
        async (spec: { name: string; image: string; labels?: Record<string, string> }) => {
          dockerState[spec.name] = createTraefikInspection({
            name: spec.name,
            image: spec.image,
            adminPort:
              spec.name === TRAEFIK_CANDIDATE_CONTAINER_NAME
                ? TRAEFIK_CANDIDATE_ADMIN_PORT
                : TRAEFIK_ADMIN_PORT,
            stateHash: spec.labels?.[TRAEFIK_CONFIG_HASH_LABEL] ?? stateHash,
          });
          return spec.name;
        }
      ),
    };

    const fetchImpl: typeof fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith(`:${TRAEFIK_CANDIDATE_ADMIN_PORT}/ping`)) {
        return new Response("OK", { status: 200 });
      }

      if (url.endsWith(`:${TRAEFIK_CANDIDATE_ADMIN_PORT}/api/http/routers`)) {
        return Response.json([
          {
            name: "http-svc_1@file",
            provider: "file",
            rule: "Host(`frontend.up.nouva.cloud`)",
          },
          {
            name: "https-svc_1@file",
            provider: "file",
            rule: "Host(`frontend.up.nouva.cloud`)",
          },
        ]);
      }

      if (url.endsWith(`:${TRAEFIK_ADMIN_PORT}/ping`)) {
        return dockerState[TRAEFIK_CONTAINER_NAME]?.Config?.Image === "traefik:v3.4"
          ? new Response("OK", { status: 200 })
          : new Response("fail", { status: 503 });
      }

      if (url.endsWith(`:${TRAEFIK_ADMIN_PORT}/api/http/routers`)) {
        return Response.json([
          {
            name: "http-svc_1@file",
            provider: "file",
            rule: "Host(`frontend.up.nouva.cloud`)",
          },
          {
            name: "https-svc_1@file",
            provider: "file",
            rule: "Host(`frontend.up.nouva.cloud`)",
          },
        ]);
      }

      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    await expect(
      reconcileTraefikRuntime(docker as never, runtimeConfig, {
        dataVolume: "nouva-agent-data",
        paths,
        fetchImpl,
        timeoutMs: 20,
        intervalMs: 1,
      })
    ).rejects.toThrow("Traefik ping endpoint is not healthy");

    expect(docker.ensureContainer.mock.calls.map((call) => call[0].image)).toEqual([
      TRAEFIK_IMAGE,
      TRAEFIK_IMAGE,
      "traefik:v3.4",
    ]);
  });

  test("should report the fixed Traefik validation keys", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "nouva-agent-traefik-"));
    const paths = getTraefikRuntimePaths(tempDir);
    await ensureTraefikState(paths);
    await writeTraefikRouteFile(paths, "svc_1", ["frontend.up.nouva.cloud"], "http://svc_1:3000");

    const staticConfig = renderTraefikStaticConfig(paths);
    const docker = {
      inspectContainer: mock(async () =>
        createTraefikInspection({
          stateHash: createTraefikStateHash(staticConfig),
        })
      ),
    };

    const fetchImpl: typeof fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/ping")) {
        return new Response("OK", { status: 200 });
      }

      if (url.endsWith("/api/http/routers")) {
        return Response.json([
          {
            name: "http-svc_1@file",
            provider: "file",
            rule: "Host(`frontend.up.nouva.cloud`)",
          },
          {
            name: "https-svc_1@file",
            provider: "file",
            rule: "Host(`frontend.up.nouva.cloud`)",
          },
        ]);
      }

      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const checks = await collectTraefikValidationChecks(docker as never, {
      paths,
      fetchImpl,
    });

    expect(checks.map((check) => check.key)).toEqual([
      "traefik-image",
      "traefik-container",
      "traefik-port-80",
      "traefik-port-443",
      "traefik-ping",
      "traefik-acme",
      "traefik-routes",
    ]);
  });
});
