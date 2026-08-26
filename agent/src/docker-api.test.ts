import { describe, expect, spyOn, test } from "bun:test";
import {
  DockerApiClient,
  DockerApiError,
  hasManagedContainerLogConfig,
  MANAGED_CONTAINER_LOG_CONFIG,
  parseDockerLogBuffer,
  parseManagedVolumeDiskUsage,
} from "./docker-api.js";

function encodeFrame(streamType: 1 | 2, payload: string): Buffer {
  const content = Buffer.from(payload, "utf8");
  const header = Buffer.alloc(8);
  header[0] = streamType;
  header.writeUInt32BE(content.length, 4);
  return Buffer.concat([header, content]);
}

describe("parseDockerLogBuffer", () => {
  test("parses multiplexed stdout and stderr log frames", () => {
    const raw = Buffer.concat([
      encodeFrame(1, "2026-03-26T12:00:00.000000000Z service ready\n"),
      encodeFrame(2, "2026-03-26T12:00:01.000000000Z failed to connect\n"),
    ]);

    expect(parseDockerLogBuffer(raw, true)).toEqual([
      {
        type: "stdout",
        timestamp: "2026-03-26T12:00:00.000000000Z",
        line: "service ready",
      },
      {
        type: "stderr",
        timestamp: "2026-03-26T12:00:01.000000000Z",
        line: "failed to connect",
      },
    ]);
  });

  test("falls back to plain stdout text when the payload is not multiplexed", () => {
    const raw = Buffer.from("first line\nsecond line\n", "utf8");

    expect(parseDockerLogBuffer(raw, false)).toEqual([
      {
        type: "stdout",
        timestamp: null,
        line: "first line",
      },
      {
        type: "stdout",
        timestamp: null,
        line: "second line",
      },
    ]);
  });
});

describe("parseManagedVolumeDiskUsage", () => {
  test("includes labeled volumes and legacy nouva volume names", () => {
    expect(
      parseManagedVolumeDiskUsage({
        Volumes: [
          {
            Name: "custom-volume",
            Labels: { "nouva.managed": "true", "nouva.volume.id": "vol_1" },
            UsageData: { Size: 4096, RefCount: 1 },
          },
          {
            Name: "nouva-vol-legacy",
            Labels: null,
            UsageData: { Size: 1024, RefCount: 0 },
          },
          {
            Name: "unmanaged",
            Labels: null,
            UsageData: { Size: 2048, RefCount: 0 },
          },
        ],
      })
    ).toEqual([
      {
        volumeName: "custom-volume",
        usedBytes: 4096,
        raw: { refCount: 1, managedByLabel: true, legacyName: false },
      },
      {
        volumeName: "nouva-vol-legacy",
        usedBytes: 1024,
        raw: { refCount: 0, managedByLabel: false, legacyName: true },
      },
    ]);
  });
});

describe("DockerApiClient.pullImage", () => {
  test("sends X-Registry-Auth only when auth is provided", async () => {
    const DockerApiClientCtor = DockerApiClient as unknown as {
      new (apiVersion: string): DockerApiClient;
    };
    const client = new DockerApiClientCtor("v1.51");
    const requestSpy = spyOn(client, "request").mockResolvedValue("");

    await client.pullImage("postgres:17");
    await client.pullImage("registry.nouva.sh/nouva/postgres:17", {
      host: "registry.nouva.sh",
      username: "srv_srv_1",
      password: "registry-password",
    });

    expect(requestSpy.mock.calls[0]?.[4]?.headers?.["X-Registry-Auth"]).toBeUndefined();
    const encodedHeader = requestSpy.mock.calls[1]?.[4]?.headers?.["X-Registry-Auth"];
    expect(typeof encodedHeader).toBe("string");
    expect(JSON.parse(Buffer.from(encodedHeader as string, "base64").toString("utf8"))).toEqual({
      username: "srv_srv_1",
      password: "registry-password",
      serveraddress: "registry.nouva.sh",
    });

    requestSpy.mockRestore();
  });
});

describe("DockerApiClient.createContainer", () => {
  test("serializes Entrypoint when it is provided", async () => {
    const DockerApiClientCtor = DockerApiClient as unknown as {
      new (apiVersion: string): DockerApiClient;
    };
    const client = new DockerApiClientCtor("v1.51");
    const requestSpy = spyOn(client, "request").mockResolvedValue({ Id: "ctr_1" });

    await client.createContainer({
      name: "nouva-pgbackrest-test",
      image: "registry.nouva.sh/nouva/postgres:17",
      entrypoint: ["sh", "-c"],
      cmd: ["echo ok"],
    });

    expect(requestSpy).toHaveBeenCalledWith(
      "POST",
      "/containers/create?name=nouva-pgbackrest-test",
      expect.objectContaining({
        Image: "registry.nouva.sh/nouva/postgres:17",
        Entrypoint: ["sh", "-c"],
        Cmd: ["echo ok"],
      })
    );

    requestSpy.mockRestore();
  });

  test.each([
    "app",
    "database",
    "worker",
    "worker_job",
    "traefik",
    "observability",
  ])("enforces bounded json-file logging for managed %s containers", async (kind) => {
    const DockerApiClientCtor = DockerApiClient as unknown as {
      new (apiVersion: string): DockerApiClient;
    };
    const client = new DockerApiClientCtor("v1.51");
    const requestSpy = spyOn(client, "request").mockResolvedValue({ Id: `ctr_${kind}` });

    await client.createContainer({
      name: `nouva-${kind}`,
      image: "example/runtime:latest",
      labels: {
        "nouva.managed": "true",
        "nouva.kind": kind,
      },
      hostConfig: {
        Mounts: [{ Type: "volume", Source: "customer-data", Target: "/data" }],
        LogConfig: {
          Type: "local",
          Config: { "max-size": "1g" },
        },
      },
    });

    expect(requestSpy).toHaveBeenCalledWith(
      "POST",
      `/containers/create?name=nouva-${kind}`,
      expect.objectContaining({
        HostConfig: expect.objectContaining({
          Mounts: [{ Type: "volume", Source: "customer-data", Target: "/data" }],
          LogConfig: MANAGED_CONTAINER_LOG_CONFIG,
        }),
      })
    );

    requestSpy.mockRestore();
  });

  test("does not rewrite logging for an unmanaged helper container", async () => {
    const DockerApiClientCtor = DockerApiClient as unknown as {
      new (apiVersion: string): DockerApiClient;
    };
    const client = new DockerApiClientCtor("v1.51");
    const requestSpy = spyOn(client, "request").mockResolvedValue({ Id: "ctr_helper" });

    await client.createContainer({
      name: "nouva-helper",
      image: "example/helper:latest",
      hostConfig: {
        LogConfig: { Type: "local", Config: { "max-size": "1m" } },
      },
    });

    expect(requestSpy).toHaveBeenCalledWith(
      "POST",
      "/containers/create?name=nouva-helper",
      expect.objectContaining({
        HostConfig: {
          LogConfig: { Type: "local", Config: { "max-size": "1m" } },
        },
      })
    );

    requestSpy.mockRestore();
  });
});

describe("DockerApiClient managed logging adoption", () => {
  test("inventories effective drift sequentially and keeps phase two fail closed", async () => {
    const DockerApiClientCtor = DockerApiClient as unknown as {
      new (apiVersion: string): DockerApiClient;
    };
    const client = new DockerApiClientCtor("v1.51");
    const inspectionOrder: string[] = [];
    const listSpy = spyOn(client, "listManagedContainers").mockResolvedValue([
      {
        Id: "ctr_app",
        Names: ["/nouva-app"],
        Labels: { "nouva.kind": "app" },
      },
      {
        Id: "ctr_database",
        Names: ["/nouva-postgres"],
        Labels: { "nouva.kind": "database" },
      },
      {
        Id: "ctr_missing",
        Names: ["/nouva-missing"],
        Labels: { "nouva.kind": "worker" },
      },
    ]);
    const inspectSpy = spyOn(client, "inspectContainer").mockImplementation(async (id) => {
      inspectionOrder.push(id);
      if (id === "ctr_missing") {
        return null;
      }
      return {
        Id: id,
        Name: id === "ctr_app" ? "/nouva-app" : "/nouva-postgres",
        HostConfig:
          id === "ctr_app"
            ? { LogConfig: MANAGED_CONTAINER_LOG_CONFIG }
            : { LogConfig: { Type: "json-file", Config: {} } },
        Config: {
          Labels: {
            "nouva.managed": "true",
            "nouva.kind": id === "ctr_app" ? "app" : "database",
          },
        },
        Mounts:
          id === "ctr_database"
            ? [
                {
                  Type: "volume",
                  Name: "nouva-vol-db",
                  Source: "/var/lib/docker/volumes/nouva-vol-db/_data",
                  Destination: "/var/lib/postgresql/data",
                },
              ]
            : [],
      };
    });

    const result = await client.inspectManagedContainerLogConfigAdoption();

    expect(inspectionOrder).toEqual(["ctr_app", "ctr_database", "ctr_missing"]);
    expect(result).toEqual({
      phase2Ready: false,
      containers: [
        {
          containerId: "ctr_app",
          containerName: "nouva-app",
          kind: "app",
          status: "compliant",
          stateful: false,
          preservedVolumeNames: [],
        },
        {
          containerId: "ctr_database",
          containerName: "nouva-postgres",
          kind: "database",
          status: "recreation_required",
          stateful: true,
          preservedVolumeNames: ["nouva-vol-db"],
        },
        {
          containerId: "ctr_missing",
          containerName: "nouva-missing",
          kind: "worker",
          status: "inspection_failed",
          stateful: false,
          preservedVolumeNames: [],
        },
      ],
    });
    expect(hasManagedContainerLogConfig(null)).toBe(false);

    listSpy.mockRestore();
    inspectSpy.mockRestore();
  });
});

describe("DockerApiClient cleanup semantics", () => {
  test("treats 404 as idempotent absence for every cleanup mutation", async () => {
    const DockerApiClientCtor = DockerApiClient as unknown as {
      new (apiVersion: string): DockerApiClient;
    };
    const client = new DockerApiClientCtor("v1.51");
    const requestSpy = spyOn(client, "request");
    const cleanupMutations = [
      () => client.removeVolume("missing"),
      () => client.removeContainer("missing"),
      () => client.removeImage("missing"),
      () => client.stopContainer("missing"),
    ];

    for (const cleanupMutation of cleanupMutations) {
      requestSpy.mockRejectedValueOnce(
        new DockerApiError(404, "DELETE", "/v1.51/resources/missing", "not found")
      );
      await expect(cleanupMutation()).resolves.toBeUndefined();
    }

    requestSpy.mockRestore();
  });

  test("treats an already-stopped container as an idempotent stop", async () => {
    const DockerApiClientCtor = DockerApiClient as unknown as {
      new (apiVersion: string): DockerApiClient;
    };
    const client = new DockerApiClientCtor("v1.51");
    const requestSpy = spyOn(client, "request").mockRejectedValue(
      new DockerApiError(304, "POST", "/v1.51/containers/already-stopped/stop", "already stopped")
    );

    await expect(client.stopContainer("already-stopped")).resolves.toBeUndefined();

    requestSpy.mockRestore();
  });

  test("passes bounded graceful-stop and cleanup deadlines to Docker", async () => {
    const DockerApiClientCtor = DockerApiClient as unknown as {
      new (apiVersion: string): DockerApiClient;
    };
    const client = new DockerApiClientCtor("v1.51");
    const requestSpy = spyOn(client, "request").mockResolvedValue("");

    await client.stopContainer("nouva-app-svc_1-live", 10, 15_000);
    await client.removeContainer("nouva-app-svc_1-live", false, 15_000);

    expect(requestSpy.mock.calls).toEqual([
      ["POST", "/containers/nouva-app-svc_1-live/stop?t=10", null, 15_000],
      ["DELETE", "/containers/nouva-app-svc_1-live?force=false", null, 15_000],
    ]);

    requestSpy.mockRestore();
  });

  test("propagates permission, conflict, daemon, and transport mutation failures", async () => {
    const DockerApiClientCtor = DockerApiClient as unknown as {
      new (apiVersion: string): DockerApiClient;
    };
    const client = new DockerApiClientCtor("v1.51");
    const requestSpy = spyOn(client, "request");
    const failures = [
      {
        error: new DockerApiError(403, "DELETE", "/v1.51/containers/blocked", "permission denied"),
        mutation: () => client.removeContainer("blocked"),
      },
      {
        error: new DockerApiError(409, "DELETE", "/v1.51/volumes/in-use", "volume is in use"),
        mutation: () => client.removeVolume("in-use"),
      },
      {
        error: new DockerApiError(500, "DELETE", "/v1.51/images/broken", "daemon unavailable"),
        mutation: () => client.removeImage("broken"),
      },
      {
        error: Object.assign(new Error("connect ECONNREFUSED /var/run/docker.sock"), {
          code: "ECONNREFUSED",
        }),
        mutation: () => client.stopContainer("offline"),
      },
    ];

    for (const { error, mutation } of failures) {
      requestSpy.mockRejectedValueOnce(error);
      await expect(mutation()).rejects.toBe(error);
    }

    requestSpy.mockRestore();
  });

  test("returns null only for 404 inspections and propagates other failures", async () => {
    const DockerApiClientCtor = DockerApiClient as unknown as {
      new (apiVersion: string): DockerApiClient;
    };
    const client = new DockerApiClientCtor("v1.51");
    const requestSpy = spyOn(client, "request");
    const inspections = [
      () => client.inspectVolume("missing"),
      () => client.inspectContainer("missing"),
      () => client.inspectImage("missing"),
    ];

    for (const inspection of inspections) {
      requestSpy.mockRejectedValueOnce(
        new DockerApiError(404, "GET", "/v1.51/resources/missing", "not found")
      );
      await expect(inspection()).resolves.toBeNull();
    }

    const daemonError = new DockerApiError(
      500,
      "GET",
      "/v1.51/volumes/broken",
      "daemon unavailable"
    );
    requestSpy.mockRejectedValueOnce(daemonError);
    await expect(client.inspectVolume("broken")).rejects.toBe(daemonError);

    requestSpy.mockRestore();
  });
});
