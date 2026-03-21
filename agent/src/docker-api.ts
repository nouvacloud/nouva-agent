import http from "node:http";
import {
  negotiateDockerApiVersion,
  type ParsedDockerStats,
  parseDockerStatsSnapshot,
} from "./protocol.js";

type HttpMethod = "GET" | "POST" | "DELETE";

export interface DockerContainerSpec {
  name: string;
  image: string;
  env?: string[];
  cmd?: string[];
  tty?: boolean;
  labels?: Record<string, string>;
  exposedPorts?: Record<string, Record<string, never>>;
  hostConfig?: Record<string, unknown>;
  networkingConfig?: Record<string, unknown>;
}

export class DockerApiClient {
  private constructor(private readonly apiVersion: string) {}

  static async create(): Promise<DockerApiClient> {
    const raw = await DockerApiClient.rawRequest("GET", "/version");
    const payload = JSON.parse(raw) as { ApiVersion?: string };
    return new DockerApiClient(negotiateDockerApiVersion(payload));
  }

  private static rawRequest(
    method: HttpMethod,
    path: string,
    body?: Record<string, unknown> | null,
    timeoutMs?: number
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: "/var/run/docker.sock",
          path,
          method,
          headers: body ? { "content-type": "application/json" } : undefined,
        },
        (res) => {
          let raw = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            raw += chunk;
          });
          res.on("end", () => {
            const statusCode = res.statusCode ?? 500;
            if (statusCode >= 400) {
              reject(new Error(`Docker API ${method} ${path} failed (${statusCode}): ${raw}`));
              return;
            }

            resolve(raw);
          });
        }
      );

      if (timeoutMs) {
        req.setTimeout(timeoutMs, () => {
          req.destroy(new Error(`Docker API timed out (${timeoutMs}ms): ${method} ${path}`));
        });
      }

      req.on("error", reject);
      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  async request<T = string>(
    method: HttpMethod,
    path: string,
    body?: Record<string, unknown> | null,
    timeoutMs?: number
  ): Promise<T> {
    const raw = await DockerApiClient.rawRequest(
      method,
      `/${this.apiVersion}${path}`,
      body,
      timeoutMs
    );
    if (!raw) {
      return "" as T;
    }

    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as T;
    }
  }

  async listManagedContainers(): Promise<
    Array<{
      Id: string;
      Names?: string[];
      State?: string;
      Labels?: Record<string, string>;
    }>
  > {
    const filters = encodeURIComponent(JSON.stringify({ label: ["nouva.managed=true"] }));
    return await this.request("GET", `/containers/json?all=true&filters=${filters}`);
  }

  async pullImage(image: string): Promise<void> {
    await this.request(
      "POST",
      `/images/create?fromImage=${encodeURIComponent(image)}`,
      null,
      5 * 60_000
    );
  }

  async ensureNetwork(name: string): Promise<void> {
    const networks = (await this.request<Array<{ Name: string }>>("GET", "/networks")) ?? [];
    if (networks.some((network) => network.Name === name)) {
      return;
    }

    await this.request("POST", "/networks/create", {
      Name: name,
      Driver: "bridge",
      Attachable: true,
    });
  }

  async createVolume(name: string): Promise<void> {
    await this.request("POST", "/volumes/create", {
      Name: name,
    });
  }

  async removeVolume(name: string, force = false): Promise<void> {
    try {
      await this.request(
        "DELETE",
        `/volumes/${encodeURIComponent(name)}${force ? "?force=true" : ""}`
      );
    } catch {}
  }

  async inspectContainer(nameOrId: string): Promise<{
    Id: string;
    Name: string;
    State?: { Running?: boolean };
  } | null> {
    try {
      return await this.request("GET", `/containers/${encodeURIComponent(nameOrId)}/json`);
    } catch {
      return null;
    }
  }

  async removeContainer(nameOrId: string, force = false): Promise<void> {
    try {
      await this.request("DELETE", `/containers/${encodeURIComponent(nameOrId)}?force=${force}`);
    } catch {}
  }

  async stopContainer(nameOrId: string): Promise<void> {
    try {
      await this.request("POST", `/containers/${encodeURIComponent(nameOrId)}/stop`);
    } catch {}
  }

  async restartContainer(nameOrId: string): Promise<void> {
    await this.request("POST", `/containers/${encodeURIComponent(nameOrId)}/restart`);
  }

  async createContainer(spec: DockerContainerSpec): Promise<string> {
    const created = await this.request<{ Id: string }>(
      "POST",
      `/containers/create?name=${encodeURIComponent(spec.name)}`,
      {
        Image: spec.image,
        Env: spec.env,
        Cmd: spec.cmd,
        Tty: spec.tty ?? false,
        Labels: spec.labels,
        ExposedPorts: spec.exposedPorts,
        HostConfig: spec.hostConfig,
        NetworkingConfig: spec.networkingConfig,
      }
    );
    return created.Id;
  }

  async startContainer(id: string): Promise<void> {
    await this.request("POST", `/containers/${encodeURIComponent(id)}/start`);
  }

  async waitContainer(id: string, timeoutMs = 30 * 60_000): Promise<number> {
    const result = await this.request<{ StatusCode?: number }>(
      "POST",
      `/containers/${encodeURIComponent(id)}/wait`,
      null,
      timeoutMs
    );
    return result.StatusCode ?? 1;
  }

  async containerLogs(id: string): Promise<string> {
    return await this.request<string>(
      "GET",
      `/containers/${encodeURIComponent(id)}/logs?stdout=true&stderr=true&timestamps=false`,
      null,
      30_000
    );
  }

  async connectNetwork(network: string, container: string): Promise<void> {
    await this.request("POST", `/networks/${encodeURIComponent(network)}/connect`, {
      Container: container,
    });
  }

  async ensureContainer(spec: DockerContainerSpec, replace = false): Promise<string> {
    const existing = await this.inspectContainer(spec.name);
    if (existing && replace) {
      await this.removeContainer(spec.name, true);
    }

    const latest = replace ? null : await this.inspectContainer(spec.name);
    if (latest) {
      if (!latest.State?.Running) {
        await this.startContainer(latest.Id);
      }
      return latest.Id;
    }

    await this.pullImage(spec.image);
    const id = await this.createContainer(spec);
    await this.startContainer(id);
    return id;
  }

  async containerStats(containerId: string): Promise<ParsedDockerStats> {
    const stats = await this.request(
      "GET",
      `/containers/${encodeURIComponent(containerId)}/stats?stream=false`,
      null,
      30_000
    );
    return parseDockerStatsSnapshot(stats);
  }
}
