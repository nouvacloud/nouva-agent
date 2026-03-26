import { describe, expect, test } from "bun:test";
import {
  buildDockerfileBuildctlArgs,
  buildStaticNginxConfig,
  buildStaticRuntimeDockerfile,
  detectDockerfileExposedPort,
  normalizeAppBuildSettings,
} from "./build.js";

describe("build helpers", () => {
  test("defaults missing build settings to railpack at repo root", () => {
    expect(normalizeAppBuildSettings(null, null)).toEqual({
      appBuildType: "railpack",
      appBuildConfig: {
        buildRoot: ".",
      },
    });
  });

  test("normalizes dockerfile settings for nested build roots", () => {
    expect(
      normalizeAppBuildSettings("dockerfile", {
        buildRoot: "./apps/web/",
        dockerfilePath: "./deploy/Dockerfile",
        dockerContextPath: "./",
        dockerBuildStage: " runner ",
      })
    ).toEqual({
      appBuildType: "dockerfile",
      appBuildConfig: {
        buildRoot: "apps/web",
        dockerfilePath: "deploy/Dockerfile",
        dockerContextPath: ".",
        dockerBuildStage: "runner",
      },
    });
  });

  test("builds dockerfile buildctl args with target stage", () => {
    expect(
      buildDockerfileBuildctlArgs({
        buildkitAddress: "tcp://127.0.0.1:1234",
        buildArgs: {
          NEXT_PUBLIC_API_URL: "https://api.example.com",
          VITE_TITLE: "Nouva Cloud",
        },
        contextDir: "/tmp/repo/apps/web",
        dockerfileDir: "/tmp/repo/apps/web/deploy",
        dockerfileName: "Dockerfile",
        imageUrl: "127.0.0.1:5000/nouva-app:dep-1",
        targetStage: "runner",
      })
    ).toEqual(
      expect.arrayContaining([
        "--frontend",
        "dockerfile.v0",
        "--local",
        "context=/tmp/repo/apps/web",
        "--local",
        "dockerfile=/tmp/repo/apps/web/deploy",
        "--opt",
        "filename=Dockerfile",
        "--opt",
        "build-arg:NEXT_PUBLIC_API_URL=https://api.example.com",
        "--opt",
        "build-arg:VITE_TITLE=Nouva Cloud",
        "--opt",
        "target=runner",
      ])
    );
  });

  test("generates static runtime artifacts with SPA fallback", () => {
    expect(
      buildStaticRuntimeDockerfile({
        intermediateImageUrl: "127.0.0.1:5000/nouva-app:dep-1-static-build",
        publishDirectoryInImage: "/app/dist",
        spaFallback: true,
      })
    ).toContain("COPY --from=127.0.0.1:5000/nouva-app:dep-1-static-build /app/dist/");

    expect(buildStaticNginxConfig(true)).toContain("try_files $uri $uri/ /index.html;");
  });

  test("detects exposed ports from Dockerfiles", () => {
    expect(
      detectDockerfileExposedPort(`
        FROM node:20-alpine
        EXPOSE 3000
      `)
    ).toBe(3000);
  });
});
