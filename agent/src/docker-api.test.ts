import { describe, expect, spyOn, test } from "bun:test";
import { DockerApiClient, parseDockerLogBuffer } from "./docker-api.js";

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
});
