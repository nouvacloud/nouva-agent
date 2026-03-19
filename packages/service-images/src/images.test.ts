import { afterEach, describe, expect, test } from "bun:test";

import {
	getDefaultVersion,
	getImageConfig,
	getPgBackrestIdentity,
	isVersionSupported,
} from "./index.js";

const imageEnvKeys = ["NOUVA_IMAGE_REGISTRY", "NOUVA_POSTGRES_IMAGE"] as const;

const originalImageEnv = Object.fromEntries(
	imageEnvKeys.map((key) => [key, process.env[key]]),
) as Record<(typeof imageEnvKeys)[number], string | undefined>;

describe("@nouvacloud/service-images", () => {
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

	test("should expose postgres defaults and pgBackRest identity helpers", () => {
		// Arrange
		const imageConfig = getImageConfig("postgres");

		// Assert
		expect(imageConfig.defaultPort).toBe(5432);
		expect(getDefaultVersion("postgres")).toBe("17");
		expect(isVersionSupported("postgres", "18")).toBe(true);
		expect(
			getPgBackrestIdentity({ projectId: "proj_1", volumeId: "vol_1" }),
		).toEqual({
			stanza: "vol-vol_1",
			repo1Path: "/postgres/v1/projects/proj_1/volumes/vol_1",
		});
	});

	test("should expose redis args-based auth configuration", () => {
		// Arrange
		const imageConfig = getImageConfig("redis");

		// Act
		const args = imageConfig.getArgs?.({
			username: "ignored",
			password: "secret",
		});

		// Assert
		expect(imageConfig.dataPath).toBe("/data");
		expect(args).toEqual(["redis-server", "--requirepass", "secret"]);
	});

	test("should include pgBackRest context when building postgres environment variables", () => {
		// Arrange
		const imageConfig = getImageConfig("postgres");

		// Act
		const envVars = imageConfig.getEnvVars(
			{
				username: "nouva_user",
				password: "super-secret",
				database: "nouva_db",
			},
			{
				serviceId: "svc_1",
				projectId: "proj_1",
				volumeId: "vol_1",
				pgBackrestEnv: {
					PGBACKREST_REPO1_S3_BUCKET: "nouva-backups",
				},
			},
		);

		// Assert
		expect(envVars).toEqual(
			expect.objectContaining({
				POSTGRES_USER: "nouva_user",
				POSTGRES_PASSWORD: "super-secret",
				POSTGRES_DB: "nouva_db",
				POSTGRES_SOCKET_DIR: "/var/lib/postgresql/.sockets",
				PGBACKREST_STANZA: "vol-vol_1",
				PGBACKREST_REPO1_PATH: "/postgres/v1/projects/proj_1/volumes/vol_1",
				PGBACKREST_REPO1_S3_BUCKET: "nouva-backups",
			}),
		);
	});

	test("should honor registry and explicit postgres image overrides at module load time", async () => {
		// Arrange
		process.env.NOUVA_IMAGE_REGISTRY = "ghcr.io/nouvacloud";

		// Act
		const registryOverrideModule = await import(
			`./images.js?registry=${Date.now()}`
		);

		// Assert
		expect(registryOverrideModule.getImageConfig("postgres").image).toBe(
			"ghcr.io/nouvacloud/postgres",
		);

		// Arrange
		process.env.NOUVA_POSTGRES_IMAGE =
			"registry.example.com/custom/postgres:17";

		// Act
		const explicitOverrideModule = await import(
			`./images.js?explicit=${Date.now()}`
		);

		// Assert
		expect(explicitOverrideModule.getImageConfig("postgres").image).toBe(
			"registry.example.com/custom/postgres:17",
		);
		expect(isVersionSupported("redis", "6.2")).toBe(false);
	});
});
