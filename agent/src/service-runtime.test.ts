import { describe, expect, test } from "bun:test";
import { resolveDatabaseProvisionSpec } from "./service-runtime.js";

describe("service runtime", () => {
  test("uses executor fields when they are present", () => {
    const resolved = resolveDatabaseProvisionSpec({
      projectId: "proj_1",
      serviceId: "svc_1",
      serviceName: "main-db",
      variant: "postgres",
      volumeId: "vol_1",
      volumeName: "nouva-vol-vol_1",
      mountPath: "/var/lib/postgresql",
      imageUrl: "registry.example.com/postgres:17",
      envVars: {
        POSTGRES_USER: "nouva_user",
      },
      containerArgs: ["postgres", "-c", "shared_buffers=128MB"],
      dataPath: "/var/lib/postgresql",
      internalPort: 5432,
      storageSizeGb: 10,
      externalHost: null,
      externalPort: null,
      publicAccessEnabled: false,
      resourceLimits: null,
    });

    expect(resolved).toEqual({
      image: "registry.example.com/postgres:17",
      envVars: {
        POSTGRES_USER: "nouva_user",
      },
      containerArgs: ["postgres", "-c", "shared_buffers=128MB"],
      dataPath: "/var/lib/postgresql",
      internalPort: 5432,
    });
  });

  test("throws when executor fields are missing", () => {
    expect(() =>
      resolveDatabaseProvisionSpec({
        projectId: "proj_1",
        serviceId: "svc_1",
        serviceName: "main-db",
        variant: "postgres",
        volumeId: "vol_1",
        volumeName: "nouva-vol-vol_1",
        mountPath: "/var/lib/postgresql",
        internalPort: 5432,
        storageSizeGb: 10,
        externalHost: null,
        externalPort: null,
        publicAccessEnabled: false,
        resourceLimits: null,
      })
    ).toThrow("missing hydrated executor fields");
  });

  test("filters non-string container args", () => {
    const resolved = resolveDatabaseProvisionSpec({
      projectId: "proj_1",
      serviceId: "svc_1",
      serviceName: "main-db",
      variant: "redis",
      volumeId: "vol_1",
      volumeName: "nouva-vol-vol_1",
      mountPath: "/data",
      imageUrl: "redis:7.4",
      envVars: {},
      containerArgs: ["redis-server", 42 as unknown as string, "--requirepass", "secret"],
      dataPath: "/data",
      internalPort: 6379,
      storageSizeGb: 5,
      externalHost: null,
      externalPort: null,
      publicAccessEnabled: false,
      resourceLimits: null,
    });

    expect(resolved.containerArgs).toEqual(["redis-server", "--requirepass", "secret"]);
  });

  test("filters non-string env var values", () => {
    const resolved = resolveDatabaseProvisionSpec({
      projectId: "proj_1",
      serviceId: "svc_1",
      serviceName: "main-db",
      variant: "postgres",
      volumeId: "vol_1",
      volumeName: "nouva-vol-vol_1",
      mountPath: "/var/lib/postgresql",
      imageUrl: "postgres:17",
      envVars: {
        POSTGRES_USER: "nouva_user",
        BROKEN: 123 as unknown as string,
      },
      containerArgs: [],
      dataPath: "/var/lib/postgresql",
      internalPort: 5432,
      storageSizeGb: 10,
      externalHost: null,
      externalPort: null,
      publicAccessEnabled: false,
      resourceLimits: null,
    });

    expect(resolved.envVars).toEqual({ POSTGRES_USER: "nouva_user" });
  });

  test("resolves mongodb executor fields for generic database runtime handling", () => {
    const resolved = resolveDatabaseProvisionSpec({
      projectId: "proj_1",
      serviceId: "svc_1",
      serviceName: "main-mongo",
      variant: "mongodb",
      volumeId: "vol_1",
      volumeName: "nouva-vol-vol_1",
      mountPath: "/data/db",
      imageUrl: "mongo:8.0",
      envVars: {
        MONGO_INITDB_ROOT_USERNAME: "root",
      },
      containerArgs: ["--bind_ip_all"],
      dataPath: "/data/db",
      internalPort: 27017,
      storageSizeGb: 10,
      externalHost: null,
      externalPort: null,
      publicAccessEnabled: false,
      resourceLimits: null,
    });

    expect(resolved).toEqual({
      image: "mongo:8.0",
      envVars: {
        MONGO_INITDB_ROOT_USERNAME: "root",
      },
      containerArgs: ["--bind_ip_all"],
      dataPath: "/data/db",
      internalPort: 27017,
    });
  });
});
