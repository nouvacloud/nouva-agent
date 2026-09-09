import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ensureTraefikState,
  getTraefikRuntimePaths,
  renderTraefikStaticConfig,
  TRAEFIK_IMAGE,
  writeTraefikRouteFile,
} from "./traefik-runtime.js";

/**
 * Proves the forwarding contract against real proxies instead of asserting the YAML we render.
 * Both hops are the images production runs, so a `trustedIPs` block Traefik silently ignores, or a
 * static config it refuses, fails here the way it would fail on a customer server.
 *
 * Gated because it needs a Docker daemon and two image pulls:
 *   RUN_DOCKER_INTEGRATION_TESTS=true bun test agent/src/traefik-forwarded-headers.docker.test.ts
 */
const dockerDescribe =
  process.env.RUN_DOCKER_INTEGRATION_TESTS === "true" ? describe : describe.skip;

const BACKEND_IMAGE = "traefik/whoami:v1.11";
const PROVIDED_HOSTNAME = "app.up.nouva.cloud";
const EDGE_ADDRESS = "10.199.0.10";
const NETWORK_SUBNET = "10.199.0.0/24";

interface ProxyChain {
  edgeHttpsPort: string;
  customerHttpPort: string;
}

async function docker(...args: string[]): Promise<string> {
  const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`docker ${args.join(" ")} failed (${exitCode}): ${stderr || stdout}`);
  }

  return stdout.trim();
}

async function publishedPort(container: string, containerPort: string): Promise<string> {
  const mapping = await docker("port", container, containerPort);
  const port = mapping.split("\n")[0]?.split(":").at(-1);
  if (!port) {
    throw new Error(`No published port for ${container}:${containerPort}`);
  }

  return port;
}

async function curl(...args: string[]): Promise<string> {
  const proc = Bun.spawn(["curl", "--silent", "--show-error", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return exitCode === 0 ? stdout : "";
}

async function waitForBody(request: () => Promise<string>, expected: string): Promise<string> {
  const deadline = Date.now() + 90_000;
  let body = "";

  while (Date.now() < deadline) {
    body = await request();
    if (body.includes(expected)) {
      return body;
    }

    await Bun.sleep(500);
  }

  throw new Error(`Proxy chain never served ${expected}. Last response: ${body || "<empty>"}`);
}

/**
 * Mirrors the central route the control plane writes for a provided hostname, minus the ACME
 * resolver: the test must not reach Let's Encrypt, and Traefik answers the handshake with its own
 * default certificate, which is all this chain needs to make the first hop HTTPS.
 */
function buildEdgeRouteConfig(targetUrl: string): string {
  return [
    "http:",
    "  routers:",
    "    edge:",
    `      rule: "Host(\`${PROVIDED_HOSTNAME}\`)"`,
    "      entryPoints:",
    "        - websecure",
    "      service: edge",
    "      tls: {}",
    "  services:",
    "    edge:",
    "      loadBalancer:",
    "        passHostHeader: true",
    "        servers:",
    `          - url: ${targetUrl}`,
    "",
  ].join("\n");
}

async function withProxyChain(
  trustedForwardedPeers: readonly string[],
  assertions: (chain: ProxyChain) => Promise<void>
): Promise<void> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const network = `nouva-fwd-${suffix}`;
  const backend = `nouva-fwd-backend-${suffix}`;
  const customerProxy = `nouva-fwd-customer-${suffix}`;
  const edgeProxy = `nouva-fwd-edge-${suffix}`;
  const stateDir = await mkdtemp(path.join(tmpdir(), "nouva-fwd-"));
  const edgeDir = await mkdtemp(path.join(tmpdir(), "nouva-fwd-edge-"));

  try {
    const hostPaths = getTraefikRuntimePaths(stateDir);
    const containerPaths = getTraefikRuntimePaths("/var/lib/nouva-agent");
    await ensureTraefikState(hostPaths);
    await writeFile(
      hostPaths.staticConfigPath,
      renderTraefikStaticConfig(containerPaths, trustedForwardedPeers),
      "utf8"
    );
    await writeTraefikRouteFile(
      hostPaths,
      "svc_1",
      { providedHostname: PROVIDED_HOSTNAME },
      `http://${backend}:80`
    );
    await writeFile(
      path.join(edgeDir, "edge.yml"),
      buildEdgeRouteConfig(`http://${customerProxy}:80`),
      "utf8"
    );

    await docker("network", "create", "--subnet", NETWORK_SUBNET, network);
    await docker("run", "--detach", "--name", backend, "--network", network, BACKEND_IMAGE);
    await docker(
      "run",
      "--detach",
      "--name",
      customerProxy,
      "--network",
      network,
      "--publish",
      "127.0.0.1::80",
      "--volume",
      `${stateDir}:/var/lib/nouva-agent`,
      TRAEFIK_IMAGE,
      `--configFile=${containerPaths.staticConfigPath}`
    );
    await docker(
      "run",
      "--detach",
      "--name",
      edgeProxy,
      "--network",
      network,
      "--ip",
      EDGE_ADDRESS,
      "--publish",
      "127.0.0.1::443",
      "--volume",
      `${edgeDir}:/etc/traefik/dynamic`,
      TRAEFIK_IMAGE,
      "--entrypoints.websecure.address=:443",
      "--providers.file.directory=/etc/traefik/dynamic",
      "--providers.file.watch=true"
    );

    await assertions({
      edgeHttpsPort: await publishedPort(edgeProxy, "443"),
      customerHttpPort: await publishedPort(customerProxy, "80"),
    });
  } finally {
    for (const container of [edgeProxy, customerProxy, backend]) {
      await docker("rm", "--force", "--volumes", container).catch(() => "");
    }
    await docker("network", "rm", network).catch(() => "");
    await rm(stateDir, { recursive: true, force: true });
    await rm(edgeDir, { recursive: true, force: true });
  }
}

function requestThroughEdge(chain: ProxyChain): Promise<string> {
  return curl(
    "--insecure",
    "--resolve",
    `${PROVIDED_HOSTNAME}:${chain.edgeHttpsPort}:127.0.0.1`,
    `https://${PROVIDED_HOSTNAME}:${chain.edgeHttpsPort}/`
  );
}

dockerDescribe("provided-domain proxy chain", () => {
  test("keeps the browser's HTTPS metadata across the edge hop", async () => {
    await withProxyChain([`${EDGE_ADDRESS}/32`], async (chain) => {
      const body = await waitForBody(() => requestThroughEdge(chain), "X-Forwarded-Proto");

      expect(body).toContain("X-Forwarded-Proto: https");
      // The port the client dialled the edge on, not the customer proxy's 80. Production
      // publishes the edge on 443; the test publishes it on an ephemeral host port.
      expect(body).toContain(`X-Forwarded-Port: ${chain.edgeHttpsPort}`);
      expect(body).toContain(`X-Forwarded-Host: ${PROVIDED_HOSTNAME}`);
      // The client stays at the head of the chain with the edge appended behind it, rather
      // than being replaced by the edge.
      expect(body.match(/X-Forwarded-For: ([^\r\n]+)/)?.[1]).toEndWith(`, ${EDGE_ADDRESS}`);
    });
  }, 240_000);

  test("replaces forwarding metadata a client asserts directly", async () => {
    await withProxyChain([`${EDGE_ADDRESS}/32`], async (chain) => {
      const body = await waitForBody(
        () =>
          curl(
            "--header",
            `Host: ${PROVIDED_HOSTNAME}`,
            "--header",
            "X-Forwarded-Proto: https",
            "--header",
            "X-Forwarded-For: 203.0.113.9",
            `http://127.0.0.1:${chain.customerHttpPort}/`
          ),
        "X-Forwarded-Proto"
      );

      expect(body).toContain("X-Forwarded-Proto: http");
      expect(body).not.toContain("203.0.113.9");
    });
  }, 240_000);

  test("loses the browser's HTTPS metadata when no edge peer is trusted", async () => {
    await withProxyChain([], async (chain) => {
      const body = await waitForBody(() => requestThroughEdge(chain), "X-Forwarded-Proto");

      // This is the reported bug: the same HTTPS request, reported to the app as plain HTTP
      // from the edge alone, with the browser gone from the chain.
      expect(body).toContain("X-Forwarded-Proto: http\r\n");
      expect(body).toContain(`X-Forwarded-For: ${EDGE_ADDRESS}\r\n`);
    });
  }, 240_000);
});
