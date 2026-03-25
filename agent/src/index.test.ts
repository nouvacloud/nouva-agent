import { describe, expect, mock, test } from "bun:test";
import type { AgentRuntimeConfig, AppDeployPayload } from "./protocol.js";
import { buildAndDeployAppWithDependencies } from "./app-build-runtime.js";

const runtimeConfig: AgentRuntimeConfig = {
  heartbeatIntervalSeconds: 30,
  pollIntervalSeconds: 10,
  leaseTtlSeconds: 120,
  metricsIntervalSeconds: 30,
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
  localTraefikNetwork: "nouva-local",
};

const payload: AppDeployPayload = {
  repoUrl: "https://example.com/repo.git",
  commitHash: "abc123",
  commitMessage: "feat: build",
  branch: "main",
  subdomain: "app",
  serviceName: "app",
  projectId: "proj_1",
  serviceId: "svc_1",
  deploymentId: "dep_1",
  envVars: {},
  appBuildType: "dockerfile",
  appBuildConfig: {
    buildRoot: "apps/web",
    dockerfilePath: "Dockerfile",
    dockerContextPath: ".",
    dockerBuildStage: "runner",
  },
  resourceLimits: null,
  runtimeMetadata: null,
};

describe("buildAndDeployAppWithDependencies", () => {
  test("ensures the base runtime before build work starts", async () => {
    const calls: string[] = [];
    const ensureBaseRuntime = mock(async () => {
      calls.push("ensure");
    });
    const buildApp = mock(async () => {
      calls.push("build");
      return {
        imageUrl: "127.0.0.1:5000/nouva-app:dep_1",
        imageSha: "sha256:test",
        buildDuration: 100,
        detectedLanguage: null,
        detectedFramework: null,
        languageVersion: null,
        internalPort: 8080,
      };
    });
    const deployAppImage = mock(async () => {
      calls.push("deploy");
      return {
        runtimeMetadata: null,
      };
    });

    await buildAndDeployAppWithDependencies(
      {
        ensureBaseRuntime,
        buildApp,
        deployAppImage,
      },
      {} as never,
      runtimeConfig,
      payload,
      "tcp://127.0.0.1:1234"
    );

    expect(calls).toEqual(["ensure", "build", "deploy"]);
    expect(buildApp).toHaveBeenCalledWith(
      expect.objectContaining({
        appBuildType: "dockerfile",
        appBuildConfig: payload.appBuildConfig,
      })
    );
  });
});
