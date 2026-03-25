import { afterEach, describe, expect, test } from "bun:test";
import {
	getLegacyPgBackrestIdentity,
	resolveDatabaseProvisionSpec,
} from "./service-runtime.js";

const imageEnvKeys = ["NOUVA_IMAGE_REGISTRY", "NOUVA_POSTGRES_IMAGE"] as const;

const originalImageEnv = Object.fromEntries(
	imageEnvKeys.map((key) => [key, process.env[key]]),
) as Record<(typeof imageEnvKeys)[number], string | undefined>;

describe("service runtime", () => {
	afterEach(() => {
		for (const key of imageEnvKeys) {
			const value = originalImageEnv[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

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

	test("supports the legacy postgres fallback payload", () => {
		const resolved = resolveDatabaseProvisionSpec({
			projectId: "proj_1",
			serviceId: "svc_1234567890abc",
			serviceName: "main-db",
			variant: "postgres",
			volumeId: "vol_1",
			volumeName: "nouva-vol-vol_1",
			mountPath: "/var/lib/postgresql",
			version: "17",
			credentials: {
				username: "nouva_user",
				password: "super-secret",
				database: "nouva_db",
			},
			internalPort: 5432,
			storageSizeGb: 10,
			externalHost: null,
			externalPort: null,
			publicAccessEnabled: false,
			resourceLimits: null,
		});

		expect(resolved.image).toBe("postgres:17");
		expect(resolved.dataPath).toBe("/var/lib/postgresql");
		expect(resolved.internalPort).toBe(5432);
		expect(resolved.containerArgs).toEqual([]);
		expect(resolved.envVars).toEqual(
			expect.objectContaining({
				POSTGRES_USER: "nouva_user",
				POSTGRES_PASSWORD: "super-secret",
				POSTGRES_DB: "nouva_db",
				POSTGRES_SOCKET_DIR: "/var/lib/postgresql/.sockets",
			}),
		);
	});

	test("supports the legacy redis fallback payload", () => {
		const resolved = resolveDatabaseProvisionSpec({
			projectId: "proj_1",
			serviceId: "svc_1",
			serviceName: "cache",
			variant: "redis",
			volumeId: "vol_1",
			volumeName: "nouva-vol-vol_1",
			mountPath: "/data",
			version: "7.4",
			credentials: {
				username: "ignored",
				password: "secret",
			},
			internalPort: 6379,
			storageSizeGb: 5,
			externalHost: null,
			externalPort: null,
			publicAccessEnabled: false,
			resourceLimits: null,
		});

		expect(resolved.image).toBe("redis:7.4");
		expect(resolved.dataPath).toBe("/data");
		expect(resolved.containerArgs).toEqual([
			"redis-server",
			"--requirepass",
			"secret",
		]);
		expect(resolved.envVars).toEqual({});
	});

	test("honors registry and explicit postgres image overrides in the legacy fallback", () => {
		process.env.NOUVA_IMAGE_REGISTRY = "ghcr.io/nouvacloud";

		expect(
			resolveDatabaseProvisionSpec({
				projectId: "proj_1",
				serviceId: "svc_1",
				serviceName: "main-db",
				variant: "postgres",
				volumeId: "vol_1",
				volumeName: "nouva-vol-vol_1",
				mountPath: "/var/lib/postgresql",
				version: "17",
				credentials: {
					username: "nouva_user",
					password: "super-secret",
				},
				internalPort: 5432,
				storageSizeGb: 10,
				externalHost: null,
				externalPort: null,
				publicAccessEnabled: false,
				resourceLimits: null,
			}).image,
		).toBe("ghcr.io/nouvacloud/postgres:17");

		process.env.NOUVA_POSTGRES_IMAGE =
			"registry.example.com/custom/postgres:17";

		expect(
			resolveDatabaseProvisionSpec({
				projectId: "proj_1",
				serviceId: "svc_1",
				serviceName: "main-db",
				variant: "postgres",
				volumeId: "vol_1",
				volumeName: "nouva-vol-vol_1",
				mountPath: "/var/lib/postgresql",
				version: "17",
				credentials: {
					username: "nouva_user",
					password: "super-secret",
				},
				internalPort: 5432,
				storageSizeGb: 10,
				externalHost: null,
				externalPort: null,
				publicAccessEnabled: false,
				resourceLimits: null,
			}).image,
		).toBe("registry.example.com/custom/postgres:17");
	});

	test("builds pgbackrest identity from the projected volume name", () => {
		expect(
			getLegacyPgBackrestIdentity({ projectId: "proj_1", volumeId: "vol_1" }),
		).toEqual({
			stanza: "vol-vol_1",
			repo1Path: "/postgres/v1/projects/proj_1/volumes/vol_1",
		});
	});

	test("uses the requested mount path in the legacy fallback", () => {
		const resolved = resolveDatabaseProvisionSpec({
			projectId: "proj_1",
			serviceId: "svc_1",
			serviceName: "main-db",
			variant: "postgres",
			volumeId: "vol_1",
			volumeName: "nouva-vol-vol_1",
			mountPath: "/srv/postgres-data",
			version: "17",
			credentials: {
				username: "nouva_user",
				password: "super-secret",
			},
			internalPort: 5432,
			storageSizeGb: 10,
			externalHost: null,
			externalPort: null,
			publicAccessEnabled: false,
			resourceLimits: null,
		});

		expect(resolved.dataPath).toBe("/srv/postgres-data");
		expect(resolved.envVars.POSTGRES_SOCKET_DIR).toBe(
			"/srv/postgres-data/.sockets",
		);
	});
});
