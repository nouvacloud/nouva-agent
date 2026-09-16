import { describe, expect, mock, test } from "bun:test";
import {
  buildDatabaseReadinessProbe,
  collectDatabaseRuntimeHealthReport,
  DatabaseReadinessError,
  observeDatabaseRuntimeHealth,
  readDatabaseProbeCredentials,
  readDatabaseProbeCredentialsFromRuntime,
  waitForDatabaseReadiness,
} from "./database-readiness.js";
import type { DockerContainerInspection } from "./docker-api.js";

const PASSWORD = "s3cr3t-pw-297";

function runningInspection(
  overrides?: Partial<DockerContainerInspection>
): DockerContainerInspection {
  return {
    Id: "ctr_db",
    Name: "/nouva-mongodb-svc_1",
    RestartCount: 0,
    State: { Running: true, Status: "running", ExitCode: 0, OOMKilled: false },
    NetworkSettings: { Networks: { "nouva-proj": { IPAddress: "172.18.0.4" } } },
    ...overrides,
  };
}

/** The exact production shape captured for #297: Docker keeps restarting an exit-1 process. */
function restartingInspection(): DockerContainerInspection {
  return {
    Id: "ctr_db",
    Name: "/nouva-mongodb-svc_1",
    RestartCount: 8,
    State: {
      Running: true,
      Status: "restarting",
      ExitCode: 1,
      OOMKilled: false,
    },
  };
}

const MONGO_KERNEL_GUARD_LOG = [
  '{"t":{"$date":"2026-09-15T21:48:26.446Z"},"s":"F","id":12257600,"ctx":"main","msg":"MongoDB cannot start: Linux kernel versions 6.19 and newer has a known incompatibility with this version of MongoDB. See https://jira.mongodb.org/browse/SERVER-121912 for more information."}',
  `{"s":"F","msg":"startup env","env":"MONGO_INITDB_ROOT_PASSWORD=${PASSWORD}"}`,
].join("\n");

describe("database readiness probes", () => {
  const credentials = { username: "nouva_main", password: PASSWORD, database: "nouva_main" };

  test("runs the probe shell itself instead of the image's own startup entrypoint", () => {
    // Managed database images own their entrypoint: the Nouva PostgreSQL image initializes a
    // cluster and starts PgBouncer while ignoring the command entirely. A probe that relies on the
    // image executing its command never runs.
    for (const engine of ["postgres", "mongodb", "mysql", "redis"] as const) {
      const probe = buildDatabaseReadinessProbe({
        engine,
        host: `nouva-${engine}-svc_1`,
        port: 5432,
        credentials,
      });

      expect(probe.entrypoint).toEqual(["/bin/sh"]);
      expect(probe.cmd[0]).toBe("-c");
      expect(probe.cmd).toHaveLength(2);
    }
  });

  test("probes MongoDB over the managed container address, never the bootstrap loopback", () => {
    const probe = buildDatabaseReadinessProbe({
      engine: "mongodb",
      host: "nouva-mongodb-svc_1",
      port: 27017,
      credentials,
    });

    const script = probe.cmd.join(" ");
    const target = [...probe.env, script].join(" ");
    expect(probe.env).toContain("NOUVA_PROBE_HOST=nouva-mongodb-svc_1");
    expect(target).not.toContain("127.0.0.1");
    expect(target).not.toContain("localhost");
    expect(script).toContain("ping");
    expect(script).not.toContain(PASSWORD);
    expect(probe.env).toContain(`NOUVA_PROBE_PASSWORD=${PASSWORD}`);
  });

  test("proves MySQL authorization with a query instead of an unauthenticated ping", () => {
    const probe = buildDatabaseReadinessProbe({
      engine: "mysql",
      host: "nouva-mysql-svc_1",
      port: 3306,
      credentials,
    });

    const script = probe.cmd.join(" ");
    expect(script).toContain("SELECT 1");
    expect(script).not.toContain("mysqladmin");
    expect(script).not.toContain(PASSWORD);
    expect(probe.env).toContain("NOUVA_PROBE_HOST=nouva-mysql-svc_1");
    expect([...probe.env, script].join(" ")).not.toContain("127.0.0.1");
    // MYSQL_PWD keeps the password off argv inside the sidecar as well.
    expect(probe.env).toContain(`MYSQL_PWD=${PASSWORD}`);
  });

  test("runs an authenticated statement for PostgreSQL", () => {
    const probe = buildDatabaseReadinessProbe({
      engine: "postgres",
      host: "nouva-postgres-svc_1",
      port: 5432,
      credentials,
    });

    const script = probe.cmd.join(" ");
    expect(script).toContain("SELECT 1");
    expect(script).not.toContain(PASSWORD);
    expect(probe.env).toContain(`PGPASSWORD=${PASSWORD}`);
    expect(probe.env).toContain("PGHOST=nouva-postgres-svc_1");
  });

  test("requires an authenticated PONG for Redis", () => {
    const probe = buildDatabaseReadinessProbe({
      engine: "redis",
      host: "nouva-redis-svc_1",
      port: 6379,
      credentials,
    });

    const script = probe.cmd.join(" ");
    expect(script).toContain("PONG");
    expect(script).not.toContain(PASSWORD);
    expect(probe.env).toContain("NOUVA_PROBE_HOST=nouva-redis-svc_1");
    expect([...probe.env, script].join(" ")).not.toContain("127.0.0.1");
    expect(probe.env).toContain(`REDISCLI_AUTH=${PASSWORD}`);
  });
});

describe("waitForDatabaseReadiness", () => {
  function createDocker(
    inspections: Array<DockerContainerInspection | null>,
    logs = ""
  ): {
    inspectContainer: ReturnType<typeof mock>;
    containerLogs: ReturnType<typeof mock>;
  } {
    let index = 0;
    return {
      inspectContainer: mock(async () => {
        const inspection = inspections[Math.min(index, inspections.length - 1)] ?? null;
        index += 1;
        return inspection;
      }),
      containerLogs: mock(async () => logs),
    };
  }

  test("returns once the authenticated probe succeeds", async () => {
    const docker = createDocker([runningInspection()]);
    const probe = mock(async () => {});

    await waitForDatabaseReadiness({
      docker: docker as never,
      containerName: "nouva-mongodb-svc_1",
      engine: "mongodb",
      probe,
      timeoutMs: 100,
      intervalMs: 1,
      probeIntervalMs: 1,
      sleep: async () => {},
    });

    expect(probe).toHaveBeenCalledTimes(1);
  });

  test("keeps waiting while the container is still starting", async () => {
    const docker = createDocker([
      { Id: "ctr_db", Name: "/nouva-mysql-svc_1", State: { Status: "created" } },
      runningInspection(),
    ]);
    let attempts = 0;
    const probe = mock(async () => {
      attempts += 1;
      if (attempts < 2) {
        throw new Error("ERROR 1045 (28000): Access denied for user");
      }
    });

    await waitForDatabaseReadiness({
      docker: docker as never,
      containerName: "nouva-mysql-svc_1",
      engine: "mysql",
      probe,
      timeoutMs: 100,
      intervalMs: 1,
      probeIntervalMs: 0,
      sleep: async () => {},
    });

    expect(attempts).toBe(2);
  });

  test("judges restarts from the supervision window, not a container's whole history", async () => {
    // A database restarted by an operator has been up for months and carries every restart the
    // policy ever performed. Only restarts after the baseline say anything about this attempt.
    const docker = createDocker([runningInspection({ RestartCount: 9 })]);
    const probe = mock(async () => {});

    await waitForDatabaseReadiness({
      docker: docker as never,
      containerName: "nouva-postgres-svc_1",
      engine: "postgres",
      probe,
      restartBaseline: 9,
      timeoutMs: 100,
      intervalMs: 1,
      probeIntervalMs: 1,
      sleep: async () => {},
    });

    expect(probe).toHaveBeenCalledTimes(1);
  });

  test("fails a restarting container instead of reporting a running database", async () => {
    const docker = createDocker([restartingInspection()], "");
    const probe = mock(async () => {});

    const error = (await waitForDatabaseReadiness({
      docker: docker as never,
      containerName: "nouva-mongodb-svc_1",
      engine: "mongodb",
      probe,
      timeoutMs: 100,
      intervalMs: 1,
      probeIntervalMs: 1,
      sleep: async () => {},
    }).catch((caught) => caught)) as DatabaseReadinessError;

    expect(error).toBeInstanceOf(DatabaseReadinessError);
    expect(error.category).toBe("container_failed");
    expect(error.message).toContain("Database container nouva-mongodb-svc_1");
    expect(error.message).toContain("8 restarts");
    expect(error.message).toContain("exit code 1");
    expect(probe).not.toHaveBeenCalled();
  });

  test("reports the known MongoDB kernel incompatibility without echoing container logs", async () => {
    const docker = createDocker([restartingInspection()], MONGO_KERNEL_GUARD_LOG);

    const error = (await waitForDatabaseReadiness({
      docker: docker as never,
      containerName: "nouva-mongodb-svc_1",
      engine: "mongodb",
      probe: async () => {},
      timeoutMs: 100,
      intervalMs: 1,
      probeIntervalMs: 1,
      sleep: async () => {},
    }).catch((caught) => caught)) as DatabaseReadinessError;

    expect(error.category).toBe("incompatible_host_kernel");
    expect(error.message).toContain("SERVER-121912");
    expect(error.message).toContain("kernel");
    expect(error.message).not.toContain(PASSWORD);
    expect(error.message).not.toContain("MONGO_INITDB_ROOT_PASSWORD");
    expect(error.message).not.toContain('{"t":');
  });

  test("fails on the deadline without echoing probe output", async () => {
    const docker = createDocker([runningInspection()]);
    let clock = 0;

    const error = (await waitForDatabaseReadiness({
      docker: docker as never,
      containerName: "nouva-postgres-svc_1",
      engine: "postgres",
      probe: async () => {
        throw new Error(`psql: FATAL: password authentication failed, tried ${PASSWORD}`);
      },
      timeoutMs: 10,
      intervalMs: 1,
      probeIntervalMs: 0,
      sleep: async () => {
        clock += 5;
      },
      now: () => clock,
    }).catch((caught) => caught)) as DatabaseReadinessError;

    expect(error.category).toBe("unready_deadline");
    expect(error.message).toContain("authenticated");
    expect(error.message).not.toContain(PASSWORD);
    expect(error.message).not.toContain("password authentication failed");
  });

  test("fails when the managed container disappeared", async () => {
    const docker = createDocker([null]);

    const error = (await waitForDatabaseReadiness({
      docker: docker as never,
      containerName: "nouva-redis-svc_1",
      engine: "redis",
      probe: async () => {},
      timeoutMs: 100,
      intervalMs: 1,
      probeIntervalMs: 1,
      sleep: async () => {},
    }).catch((caught) => caught)) as DatabaseReadinessError;

    expect(error.category).toBe("container_missing");
  });
});

describe("readDatabaseProbeCredentials", () => {
  test("recovers the managed credentials each engine was started with", () => {
    expect(
      readDatabaseProbeCredentials("postgres", {
        Id: "c",
        Name: "/n",
        Config: {
          Env: [
            `POSTGRES_USER=nouva_main`,
            `POSTGRES_PASSWORD=${PASSWORD}`,
            "POSTGRES_DB=nouva_main",
          ],
        },
      })
    ).toEqual({ username: "nouva_main", password: PASSWORD, database: "nouva_main" });

    expect(
      readDatabaseProbeCredentials("mongodb", {
        Id: "c",
        Name: "/n",
        Config: {
          Env: [`MONGO_INITDB_ROOT_USERNAME=nouva_main`, `MONGO_INITDB_ROOT_PASSWORD=${PASSWORD}`],
        },
      })
    ).toEqual({ username: "nouva_main", password: PASSWORD, database: "admin" });

    expect(
      readDatabaseProbeCredentials("mysql", {
        Id: "c",
        Name: "/n",
        Config: {
          Env: [`MYSQL_USER=nouva_main`, `MYSQL_PASSWORD=${PASSWORD}`, "MYSQL_DATABASE=nouva_main"],
        },
      })
    ).toEqual({ username: "nouva_main", password: PASSWORD, database: "nouva_main" });

    expect(
      readDatabaseProbeCredentials("redis", {
        Id: "c",
        Name: "/n",
        Config: { Cmd: ["redis-server", "--requirepass", PASSWORD] },
      })
    ).toEqual({ username: "default", password: PASSWORD, database: null });
  });

  test("reads the same credentials from the runtime definition a container is created with", () => {
    expect(
      readDatabaseProbeCredentialsFromRuntime("mysql", {
        envVars: {
          MYSQL_ROOT_PASSWORD: PASSWORD,
          MYSQL_USER: "nouva_main",
          MYSQL_PASSWORD: PASSWORD,
          MYSQL_DATABASE: "nouva_main",
        },
        containerArgs: [],
      })
    ).toEqual({ username: "nouva_main", password: PASSWORD, database: "nouva_main" });

    expect(
      readDatabaseProbeCredentialsFromRuntime("redis", {
        envVars: {},
        containerArgs: ["redis-server", "--requirepass", PASSWORD],
      })
    ).toEqual({ username: "default", password: PASSWORD, database: null });

    expect(
      readDatabaseProbeCredentialsFromRuntime("postgres", { envVars: {}, containerArgs: [] })
    ).toBeNull();
  });

  test("returns null when the container does not carry usable credentials", () => {
    expect(
      readDatabaseProbeCredentials("postgres", { Id: "c", Name: "/n", Config: { Env: [] } })
    ).toBeNull();
    expect(readDatabaseProbeCredentials("redis", { Id: "c", Name: "/n", Config: {} })).toBeNull();
  });
});

describe("observeDatabaseRuntimeHealth", () => {
  const container = {
    serviceId: "svc_1",
    containerId: "ctr_db",
    containerName: "nouva-mongodb-svc_1",
    engine: "mongodb" as const,
  };

  test("reports ready only after an authenticated probe succeeds", async () => {
    const observation = await observeDatabaseRuntimeHealth({
      docker: {
        inspectContainer: async () =>
          runningInspection({
            Config: {
              Env: [
                `MONGO_INITDB_ROOT_USERNAME=nouva_main`,
                `MONGO_INITDB_ROOT_PASSWORD=${PASSWORD}`,
              ],
            },
          }),
        containerLogs: async () => "",
      } as never,
      container,
      runProbe: async () => {},
      now: () => new Date("2026-09-16T00:00:00.000Z"),
    });

    expect(observation).toEqual({
      serviceId: "svc_1",
      containerId: "ctr_db",
      containerName: "nouva-mongodb-svc_1",
      engine: "mongodb",
      state: "ready",
      reason: "authenticated_probe_succeeded",
      observedAt: "2026-09-16T00:00:00.000Z",
    });
  });

  test("reports a restarting container as unavailable", async () => {
    const observation = await observeDatabaseRuntimeHealth({
      docker: {
        inspectContainer: async () => restartingInspection(),
        containerLogs: async () => "",
      } as never,
      container,
      runProbe: async () => {},
      now: () => new Date("2026-09-16T00:00:00.000Z"),
    });

    expect(observation.state).toBe("unavailable");
    expect(observation.reason).toBe("container_restarting");
  });

  test("reports the MongoDB kernel incompatibility as its own unavailable reason", async () => {
    const observation = await observeDatabaseRuntimeHealth({
      docker: {
        inspectContainer: async () => restartingInspection(),
        containerLogs: async () => MONGO_KERNEL_GUARD_LOG,
      } as never,
      container,
      runProbe: async () => {},
      now: () => new Date("2026-09-16T00:00:00.000Z"),
    });

    expect(observation.state).toBe("unavailable");
    expect(observation.reason).toBe("incompatible_host_kernel");
  });

  test("never revives a service from an unproven probe", async () => {
    const failedProbe = await observeDatabaseRuntimeHealth({
      docker: {
        inspectContainer: async () =>
          runningInspection({
            Config: {
              Env: [
                `MONGO_INITDB_ROOT_USERNAME=nouva_main`,
                `MONGO_INITDB_ROOT_PASSWORD=${PASSWORD}`,
              ],
            },
          }),
        containerLogs: async () => "",
      } as never,
      container,
      runProbe: async () => {
        throw new Error(`auth failed for nouva_main using ${PASSWORD}`);
      },
      now: () => new Date("2026-09-16T00:00:00.000Z"),
    });

    expect(failedProbe.state).toBe("unknown");
    expect(failedProbe.reason).toBe("probe_unavailable");

    const missingCredentials = await observeDatabaseRuntimeHealth({
      docker: {
        inspectContainer: async () => runningInspection({ Config: { Env: [] } }),
        containerLogs: async () => "",
      } as never,
      container,
      runProbe: async () => {},
      now: () => new Date("2026-09-16T00:00:00.000Z"),
    });

    expect(missingCredentials.state).toBe("unknown");
    expect(missingCredentials.reason).toBe("probe_unavailable");
  });

  test("reports a vanished container as unavailable", async () => {
    const observation = await observeDatabaseRuntimeHealth({
      docker: {
        inspectContainer: async () => null,
        containerLogs: async () => "",
      } as never,
      container,
      runProbe: async () => {},
      now: () => new Date("2026-09-16T00:00:00.000Z"),
    });

    expect(observation.state).toBe("unavailable");
    expect(observation.reason).toBe("container_missing");
  });
});

describe("collectDatabaseRuntimeHealthReport", () => {
  const managedContainers = [
    {
      Id: "ctr_db",
      Names: ["/nouva-mongodb-svc_1"],
      State: "restarting",
      Labels: {
        "nouva.managed": "true",
        "nouva.kind": "database",
        "nouva.service.id": "svc_1",
        "nouva.service.variant": "mongodb",
      },
    },
    {
      Id: "ctr_app",
      Names: ["/nouva-app-svc_2-dep_1"],
      State: "running",
      Labels: {
        "nouva.managed": "true",
        "nouva.kind": "app",
        "nouva.service.id": "svc_2",
      },
    },
  ];

  test("inventories every managed database container and nothing else", async () => {
    const report = await collectDatabaseRuntimeHealthReport({
      docker: {
        listManagedContainers: async () => managedContainers,
        inspectContainer: async () => restartingInspection(),
        containerLogs: async () => "",
      } as never,
      runProbe: async () => {},
      now: () => new Date("2026-09-16T00:00:00.000Z"),
    });

    expect(report).toEqual({
      observedAt: "2026-09-16T00:00:00.000Z",
      containers: [
        {
          serviceId: "svc_1",
          containerId: "ctr_db",
          containerName: "nouva-mongodb-svc_1",
          engine: "mongodb",
          state: "unavailable",
          reason: "container_restarting",
          observedAt: "2026-09-16T00:00:00.000Z",
        },
      ],
    });
  });

  test("keeps a database whose variant label a previous agent never wrote", async () => {
    const report = await collectDatabaseRuntimeHealthReport({
      docker: {
        listManagedContainers: async () => [
          {
            Id: "ctr_legacy",
            Names: ["/nouva-postgres-svc_9"],
            State: "running",
            Labels: {
              "nouva.managed": "true",
              "nouva.kind": "database",
              "nouva.service.id": "svc_9",
            },
          },
        ],
        inspectContainer: async () =>
          runningInspection({
            Config: {
              Env: [`POSTGRES_USER=nouva_main`, `POSTGRES_PASSWORD=${PASSWORD}`],
            },
          }),
        containerLogs: async () => "",
      } as never,
      runProbe: async () => {},
      now: () => new Date("2026-09-16T00:00:00.000Z"),
    });

    expect(report.containers).toEqual([
      {
        serviceId: "svc_9",
        containerId: "ctr_legacy",
        containerName: "nouva-postgres-svc_9",
        engine: "postgres",
        state: "ready",
        reason: "authenticated_probe_succeeded",
        observedAt: "2026-09-16T00:00:00.000Z",
      },
    ]);
  });

  test("reports a database whose engine cannot be resolved instead of dropping it", async () => {
    const report = await collectDatabaseRuntimeHealthReport({
      docker: {
        listManagedContainers: async () => [
          {
            Id: "ctr_unknown",
            Names: ["/nouva-db-legacy-svc_8"],
            State: "running",
            Labels: {
              "nouva.managed": "true",
              "nouva.kind": "database",
              "nouva.service.id": "svc_8",
            },
          },
        ],
        inspectContainer: async () => runningInspection(),
        containerLogs: async () => "",
      } as never,
      // An unresolved engine has no probe to run; the container must still appear in the inventory,
      // because absence is what makes the control plane fail a service.
      runProbe: async () => {
        throw new Error("an unresolved engine must never be probed");
      },
      now: () => new Date("2026-09-16T00:00:00.000Z"),
    });

    expect(report.containers).toEqual([
      {
        serviceId: "svc_8",
        containerId: "ctr_unknown",
        containerName: "nouva-db-legacy-svc_8",
        engine: "",
        state: "unknown",
        reason: "probe_unavailable",
        observedAt: "2026-09-16T00:00:00.000Z",
      },
    ]);
  });

  test("times the inventory at listing and each observation at its own completion", async () => {
    // A pass over many databases takes as long as its probes. The envelope keeps the instant the
    // inventory was taken (what absence is judged against) while every entry carries the instant it
    // was actually observed, so a slow pass cannot age its own fresh observations out.
    let clock = Date.parse("2026-09-16T00:00:00.000Z");
    const report = await collectDatabaseRuntimeHealthReport({
      docker: {
        listManagedContainers: async () => {
          clock += 1_000;
          return [
            {
              Id: "ctr_a",
              Names: ["/nouva-postgres-svc_a"],
              State: "running",
              Labels: {
                "nouva.managed": "true",
                "nouva.kind": "database",
                "nouva.service.id": "svc_a",
                "nouva.service.variant": "postgres",
              },
            },
            {
              Id: "ctr_b",
              Names: ["/nouva-postgres-svc_b"],
              State: "running",
              Labels: {
                "nouva.managed": "true",
                "nouva.kind": "database",
                "nouva.service.id": "svc_b",
                "nouva.service.variant": "postgres",
              },
            },
          ];
        },
        inspectContainer: async () =>
          runningInspection({
            Config: {
              Env: [`POSTGRES_USER=nouva_main`, `POSTGRES_PASSWORD=${PASSWORD}`],
            },
          }),
        containerLogs: async () => "",
      } as never,
      runProbe: async () => {
        clock += 60_000;
      },
      concurrency: 1,
      now: () => new Date(clock),
    });

    // Stamped before the listing: a container created while the list was being taken must never be
    // read as missing from an inventory that claims to postdate it.
    expect(report.observedAt).toBe("2026-09-16T00:00:00.000Z");
    expect(report.containers.map((container) => container.observedAt)).toEqual([
      "2026-09-16T00:01:01.000Z",
      "2026-09-16T00:02:01.000Z",
    ]);
  });

  test("publishes a complete inventory up front and refreshes it as each probe finishes", async () => {
    // A pass long enough to outlive the acceptance window must not starve the databases it observed
    // first: every snapshot lists every container the host holds, and each finished observation is
    // published as soon as it completes instead of waiting for the slowest probe.
    let clock = Date.parse("2026-09-16T00:00:00.000Z");
    const snapshots: Array<{
      observedAt: string;
      containers: Array<{ serviceId: string; state: string; observedAt: string }>;
    }> = [];

    const report = await collectDatabaseRuntimeHealthReport({
      docker: {
        listManagedContainers: async () => {
          clock += 1_000;
          return ["svc_a", "svc_b"].map((serviceId) => ({
            Id: `ctr_${serviceId}`,
            Names: [`/nouva-postgres-${serviceId}`],
            State: "running",
            Labels: {
              "nouva.managed": "true",
              "nouva.kind": "database",
              "nouva.service.id": serviceId,
              "nouva.service.variant": "postgres",
            },
          }));
        },
        inspectContainer: async () =>
          runningInspection({
            Config: {
              Env: [`POSTGRES_USER=nouva_main`, `POSTGRES_PASSWORD=${PASSWORD}`],
            },
          }),
        containerLogs: async () => "",
      } as never,
      runProbe: async () => {
        clock += 600_000;
      },
      concurrency: 1,
      now: () => new Date(clock),
      onReport: (snapshot) =>
        snapshots.push(
          snapshot as unknown as {
            observedAt: string;
            containers: Array<{ serviceId: string; state: string; observedAt: string }>;
          }
        ),
    });

    expect(snapshots).toHaveLength(3);
    expect(snapshots[0]?.observedAt).toBe("2026-09-16T00:00:00.000Z");
    expect(
      snapshots[0]?.containers.map((container) => [container.serviceId, container.state])
    ).toEqual([
      ["svc_a", "unknown"],
      ["svc_b", "unknown"],
    ]);

    // The first database's evidence is available ten minutes before the pass ends.
    expect(snapshots[1]?.containers[0]).toEqual(
      expect.objectContaining({
        serviceId: "svc_a",
        state: "ready",
        observedAt: "2026-09-16T00:10:01.000Z",
      })
    );
    expect(snapshots[1]?.containers[1]?.state).toBe("unknown");

    // Published snapshots are never mutated by later observations.
    expect(snapshots[0]?.containers[0]?.state).toBe("unknown");
    expect(report.containers.map((container) => container.state)).toEqual(["ready", "ready"]);
  });
});
