import { describe, expect, mock, test } from "bun:test";
import type { DockerContainerInspection } from "./docker-api.js";
import {
  buildManagedPostgresTarget,
  collectPostgresObservabilitySamplesWithDependencies,
  isManagedPostgresContainer,
  readContainerEnv,
  resolveContainerIpAddress,
} from "./postgres-observability.js";

const postgresContainer = {
  Id: "ctr_pg_1",
  Names: ["/nouva-postgres-svc_1"],
  State: "running",
  Labels: {
    "nouva.kind": "database",
    "nouva.service.id": "svc_1",
  },
};

const postgresInspection: DockerContainerInspection = {
  Id: "ctr_pg_1",
  Name: "/nouva-postgres-svc_1",
  Config: {
    Labels: {
      "nouva.kind": "database",
      "nouva.service.id": "svc_1",
      "nouva.service.variant": "postgres",
    },
    Env: [
      "POSTGRES_USER=nouva_user",
      "POSTGRES_PASSWORD=super-secret",
      "POSTGRES_DB=main_db",
      "POSTGRES_PORT=6543",
    ],
  },
  NetworkSettings: {
    Networks: {
      "nouva-project-network": {
        IPAddress: "172.20.0.12",
      },
    },
  },
};

describe("postgres observability helpers", () => {
  test("should parse container env and resolve the first network IP", () => {
    expect(
      readContainerEnv([
        "POSTGRES_USER=nouva_user",
        "POSTGRES_PASSWORD=super-secret",
        "INVALID",
      ]),
    ).toEqual({
      POSTGRES_USER: "nouva_user",
      POSTGRES_PASSWORD: "super-secret",
    });

    expect(resolveContainerIpAddress(postgresInspection)).toBe("172.20.0.12");
  });

  test("should detect managed postgres containers via label or legacy name", () => {
    expect(isManagedPostgresContainer(postgresContainer, postgresInspection)).toBe(true);
    expect(
      isManagedPostgresContainer(
        {
          ...postgresContainer,
          Labels: {
            "nouva.kind": "database",
            "nouva.service.id": "svc_1",
          },
        },
        {
          ...postgresInspection,
          Config: {
            Labels: {
              "nouva.kind": "database",
              "nouva.service.id": "svc_1",
            },
          },
        },
      ),
    ).toBe(true);
  });

  test("should build a postgres target from inspected container data", () => {
    expect(buildManagedPostgresTarget(postgresContainer, postgresInspection)).toEqual({
      serviceId: "svc_1",
      host: "172.20.0.12",
      port: 6543,
      username: "nouva_user",
      password: "super-secret",
      database: "main_db",
    });
  });

  test("should emit success and error samples per service", async () => {
    const docker = {
      listManagedContainers: mock(async () => [
        postgresContainer,
        {
          Id: "ctr_pg_2",
          Names: ["/nouva-postgres-svc_2"],
          State: "running",
          Labels: {
            "nouva.kind": "database",
            "nouva.service.id": "svc_2",
          },
        },
      ]),
      inspectContainer: mock(async (id: string) => {
        if (id === "ctr_pg_1") {
          return postgresInspection;
        }

        return {
          ...postgresInspection,
          Id: id,
          Name: "/nouva-postgres-svc_2",
          Config: {
            Labels: {
              "nouva.kind": "database",
              "nouva.service.id": "svc_2",
              "nouva.service.variant": "postgres",
            },
            Env: [
              "POSTGRES_USER=nouva_user",
              "POSTGRES_PASSWORD=super-secret",
              "POSTGRES_DB=main_db",
            ],
          },
          NetworkSettings: {
            Networks: {
              "nouva-project-network": {
                IPAddress: "172.20.0.13",
              },
            },
          },
        } satisfies DockerContainerInspection;
      }),
    };

    const fetchSnapshot = mock(async (target: { serviceId: string }) => {
      if (target.serviceId === "svc_2") {
        throw new Error("pg_stat_monitor is not available");
      }

      return {
        collectedAt: "2026-03-26T12:00:00.000Z",
        extensionStatus: {
          pgStatMonitor: true,
          pgCron: false,
        },
        activeSessions: [{ state: "active", count: 2 }],
        slowQueries: [],
      };
    });

    const samples = await collectPostgresObservabilitySamplesWithDependencies(
      docker as never,
      {
        fetchSnapshot,
        now: () => "2026-03-26T12:00:30.000Z",
      },
    );

    expect(samples).toEqual([
      {
        serviceId: "svc_1",
        collectedAt: "2026-03-26T12:00:00.000Z",
        status: "success",
        errorMessage: null,
        extensionStatus: {
          pgStatMonitor: true,
          pgCron: false,
        },
        activeSessions: [{ state: "active", count: 2 }],
        slowQueries: [],
      },
      {
        serviceId: "svc_2",
        collectedAt: "2026-03-26T12:00:30.000Z",
        status: "error",
        errorMessage: "pg_stat_monitor is not available",
        extensionStatus: null,
        activeSessions: null,
        slowQueries: null,
      },
    ]);
  });
});
