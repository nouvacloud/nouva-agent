import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BuildctlExecutionError,
  buildDockerfileBuildctlArgs,
  buildRailpackBuildctlArgs,
  buildStaticNginxConfig,
  buildStaticRuntimeDockerfile,
  detectDockerfileExposedPort,
  normalizeAppBuildSettings,
  stripRepositoryGitMetadata,
  toSafeBuildctlExecutionError,
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
        output:
          "type=image,name=127.0.0.1:5000/nouva-app:dep-1,push=true,registry.insecure=true,registry.http=true",
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

  test("replaces buildctl command failures without retaining argv or build arguments", () => {
    const unsafeError = new Error(
      "Command failed: buildctl --opt build-arg:Q=x --opt build-arg:UV=yz"
    );

    const safeError = toSafeBuildctlExecutionError(unsafeError);

    expect(safeError).toBeInstanceOf(BuildctlExecutionError);
    expect(safeError.message).toBe("BuildKit build failed");
    expect(safeError.message).not.toContain("buildctl");
    expect(safeError.message).not.toContain("build-arg");
    expect(safeError.message).not.toContain("Q=x");
    expect(safeError.cause).toBeUndefined();
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

  test("generates static runtime artifacts from a local build context", () => {
    expect(
      buildStaticRuntimeDockerfile({
        publishDirectoryInContext: "static-export/app/dist",
        spaFallback: false,
      })
    ).toContain("COPY static-export/app/dist/ /usr/share/nginx/html/");
  });

  test("passes env var keys as buildctl secrets for railpack builds", () => {
    const args = buildRailpackBuildctlArgs({
      buildkitAddress: "tcp://127.0.0.1:1234",
      buildRootDir: "/tmp/repo/backend",
      planDir: "/tmp/nouva-railpack-plan-abc",
      planFileName: "railpack-plan.json",
      output:
        "type=image,name=127.0.0.1:5000/nouva-app:dep-1,push=true,registry.insecure=true,registry.http=true",
      envVarKeys: ["DATABASE_URL", "ACCESS_KEY_ID"],
    });

    expect(args).toContain("--secret");
    expect(args).toContain("id=DATABASE_URL,env=DATABASE_URL");
    expect(args).toContain("id=ACCESS_KEY_ID,env=ACCESS_KEY_ID");
  });

  test("omits secrets when no env var keys provided", () => {
    const args = buildRailpackBuildctlArgs({
      buildkitAddress: "tcp://127.0.0.1:1234",
      buildRootDir: "/tmp/repo",
      planDir: "/tmp/nouva-railpack-plan-abc",
      planFileName: "railpack-plan.json",
      output:
        "type=image,name=127.0.0.1:5000/nouva-app:dep-1,push=true,registry.insecure=true,registry.http=true",
    });

    expect(args).not.toContain("--secret");
  });

  test("reads the railpack plan from its own local instead of the build context", () => {
    // The plan lists every env var name as a build secret and railpack copies the context into
    // the image, so the plan must never be inside the context.
    const args = buildRailpackBuildctlArgs({
      buildkitAddress: "tcp://127.0.0.1:1234",
      buildRootDir: "/tmp/repo/backend",
      planDir: "/tmp/nouva-railpack-plan-abc",
      planFileName: "railpack-plan.json",
      output: "type=oci,dest=/tmp/out.tar",
    });

    expect(args).toContain("context=/tmp/repo/backend");
    expect(args).toContain("dockerfile=/tmp/nouva-railpack-plan-abc");
    expect(args).not.toContain("dockerfile=/tmp/repo/backend");
    expect(args).toContain("filename=railpack-plan.json");
  });

  test("refuses a railpack plan directory that is the build context", () => {
    expect(() =>
      buildRailpackBuildctlArgs({
        buildkitAddress: "tcp://127.0.0.1:1234",
        buildRootDir: "/tmp/repo/backend",
        planDir: "/tmp/repo/backend/",
        planFileName: "railpack-plan.json",
        output: "type=oci,dest=/tmp/out.tar",
      })
    ).toThrow("railpack plan directory must not be the build context");
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

// #163: railpack hands the checkout to buildctl as `--local context=`, so anything left in the
// working tree lands in `/app`. The image used to ship the full history and the remote URL with it.
describe("stripRepositoryGitMetadata", () => {
  async function withTempRepo(run: (repoDir: string) => Promise<void>) {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "nouva-strip-git-"));
    try {
      await run(repoDir);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  }

  test("removes a .git directory and leaves the rest of the tree", async () => {
    await withTempRepo(async (repoDir) => {
      await mkdir(path.join(repoDir, ".git", "refs"), { recursive: true });
      await writeFile(path.join(repoDir, ".git", "config"), '[remote "origin"]\n');
      await mkdir(path.join(repoDir, "src"), { recursive: true });
      await writeFile(path.join(repoDir, "src", "index.ts"), "export {};\n");
      await writeFile(path.join(repoDir, ".gitignore"), "node_modules\n");

      await stripRepositoryGitMetadata(repoDir);

      expect((await readdir(repoDir)).sort()).toEqual([".gitignore", "src"]);
    });
  });

  // A worktree or submodule checkout has `.git` as a file holding a `gitdir:` pointer, not a
  // directory, and that pointer is just as unwanted in the image.
  test("removes a .git file", async () => {
    await withTempRepo(async (repoDir) => {
      await writeFile(path.join(repoDir, ".git"), "gitdir: /var/lib/git/worktrees/app\n");

      await stripRepositoryGitMetadata(repoDir);

      expect(await readdir(repoDir)).toEqual([]);
    });
  });

  // The shallow-clone fallback in `cloneRepository` deletes and re-clones, so a repo can reach the
  // build with no `.git` at all. That must not fail the build.
  test("is a no-op when there is nothing to remove", async () => {
    await withTempRepo(async (repoDir) => {
      await writeFile(path.join(repoDir, "README.md"), "# app\n");

      await stripRepositoryGitMetadata(repoDir);

      expect(await readdir(repoDir)).toEqual(["README.md"]);
    });
  });

  // Removal must not follow a symlink out of the checkout: a repo can commit `.git` as a symlink,
  // and `rm -r` on the link itself must unlink it rather than delete the target's contents.
  test("unlinks a symlinked .git without touching the target", async () => {
    await withTempRepo(async (repoDir) => {
      const outside = path.join(repoDir, "outside");
      await mkdir(outside, { recursive: true });
      await writeFile(path.join(outside, "keep.txt"), "keep\n");
      await mkdir(path.join(repoDir, "checkout"), { recursive: true });
      await symlink(outside, path.join(repoDir, "checkout", ".git"), "dir");

      await stripRepositoryGitMetadata(path.join(repoDir, "checkout"));

      expect(await readdir(path.join(repoDir, "checkout"))).toEqual([]);
      expect(await readdir(outside)).toEqual(["keep.txt"]);
    });
  });
});
