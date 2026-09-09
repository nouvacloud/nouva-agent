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
  classifyBuildFailure,
  detectDockerfileExposedPort,
  normalizeAppBuildSettings,
  resolveDetectedFramework,
  stripRepositoryGitMetadata,
  toSafeBuildctlExecutionError,
  withBuildMemoryBudget,
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

// #215: on a 4 GB server the build reserve gives the scoped builder ~571 MiB, which a default
// Next.js build goes over. The deployment only ever said "BuildKit build failed", so nothing told
// the user they had run out of build memory or what they could do about it.
describe("build failure classification", () => {
  // 15% of a 3,900,644 KiB host: the reserve the agent applied to the builder in the report.
  const builderMemoryBytes = 599_138_919;

  test("classifies the memory kill BuildKit reported on a constrained server", () => {
    expect(
      classifyBuildFailure({
        exitCode: 1,
        signal: null,
        output: [
          '#18 102.4 error: script "build" was terminated by signal SIGKILL (Forced quit)',
          'process "bun run build" did not complete successfully: cannot allocate memory',
          "ResourceExhausted",
        ].join("\n"),
      })
    ).toBe("out-of-memory");
  });

  test("classifies the other shapes a memory kill reaches the agent in", () => {
    const outputs = [
      'process "/bin/sh -c npm run build" did not complete successfully: exit code: 137',
      "runc run failed: unable to start container process: cannot allocate memory",
      "container for step exited: OOMKilled",
      "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
      "Memory cgroup out of memory: Killed process 14026 (node)",
    ];

    for (const output of outputs) {
      expect(classifyBuildFailure({ exitCode: 1, signal: null, output })).toBe("out-of-memory");
    }
  });

  test("classifies a build process the kernel killed outright", () => {
    expect(classifyBuildFailure({ exitCode: -1, signal: "SIGKILL", output: "" })).toBe(
      "out-of-memory"
    );
  });

  // `ResourceExhausted` is a plain gRPC status name, so a build step that calls a cloud API and
  // logs a quota refusal must not be sent off to buy a bigger server.
  test("leaves a build that merely logs a resource-exhausted status unclassified", () => {
    expect(
      classifyBuildFailure({
        exitCode: 1,
        signal: null,
        output: [
          "uploading assets: rpc error: code = ResourceExhausted desc = quota exceeded",
          'process "npm run build" did not complete successfully: exit code: 1',
        ].join("\n"),
      })
    ).toBe("unknown");
  });

  // A nested runner reporting its own timeout kill is not the builder running out of memory.
  test("leaves a build that merely reports killing a process unclassified", () => {
    expect(
      classifyBuildFailure({
        exitCode: 1,
        signal: null,
        output: [
          "test timed out after 30s, sending SIGKILL to the worker",
          "  teardown: child exited with signal: killed",
          'process "npm test" did not complete successfully: exit code: 1',
        ].join("\n"),
      })
    ).toBe("unknown");
  });

  // Two unrelated lines must not vouch for each other: this build failed on a registry quota and
  // separately killed a hung test, and neither has anything to do with the builder's memory.
  test("leaves a quota refusal and an unrelated kill in one build unclassified", () => {
    expect(
      classifyBuildFailure({
        exitCode: 1,
        signal: null,
        output: [
          "#7 [3/8] RUN npm test",
          "#7 41.2 test timed out after 30s, sending SIGKILL to the worker",
          "#7 DONE 41.4s",
          "#9 [5/8] RUN npm publish --registry https://registry.example.com",
          "#9 12.7 npm ERR! 429 rpc error: code = ResourceExhausted desc = quota exceeded",
          'error: failed to solve: process "/bin/sh -c npm publish" did not complete successfully: exit code: 1',
        ].join("\n"),
      })
    ).toBe("unknown");
  });

  // Measured on BuildKit v0.17.0 against a daemon capped at 256 MiB, for both an allocation the
  // kernel refused (`dd bs=1G`) and a step it OOM-killed (`tail /dev/zero`, confirmed by
  // `oom-kill:constraint=CONSTRAINT_MEMCG` in dmesg). Both report this, and buildctl exits 1.
  test("classifies the output a memory-capped BuildKit daemon actually produces", () => {
    expect(
      classifyBuildFailure({
        exitCode: 1,
        signal: null,
        output: [
          "#5 [2/2] RUN tail /dev/zero",
          '#5 ERROR: process "/bin/sh -c tail /dev/zero" did not complete successfully: cannot allocate memory',
          "------",
          " > [2/2] RUN tail /dev/zero:",
          "------",
          'error: failed to solve: ResourceExhausted: process "/bin/sh -c tail /dev/zero" did not complete successfully: cannot allocate memory',
        ].join("\n"),
      })
    ).toBe("out-of-memory");
  });

  test("classifies a build whose own process was killed, whatever it logged", () => {
    expect(
      classifyBuildFailure({
        exitCode: 137,
        signal: null,
        output: "npm ERR! 429 ResourceExhausted desc = quota exceeded",
      })
    ).toBe("out-of-memory");
  });

  test("leaves a compile error that merely mentions memory unclassified", () => {
    expect(
      classifyBuildFailure({
        exitCode: 1,
        signal: null,
        output: [
          "app/page.tsx(12,7): error TS2322: Type 'MemoryUsage' is not assignable to type 'string'.",
          "  The memory report is out of date and out of scope.",
          'process "npm run build" did not complete successfully: exit code: 1',
        ].join("\n"),
      })
    ).toBe("unknown");
  });

  test("reports an out-of-memory build with the builder's budget and a way out", () => {
    const error = withBuildMemoryBudget(
      new BuildctlExecutionError("out-of-memory"),
      builderMemoryBytes
    );

    expect(error).toBeInstanceOf(BuildctlExecutionError);
    const message = (error as BuildctlExecutionError).message;
    expect(message).toContain("ran out of memory");
    expect(message).toContain("571 MiB");
    // Raising the service's memory cannot raise the builder's, so the message must not imply it.
    expect(message).toContain("service's own memory limit");
    expect(message).toContain("server with more memory");
  });

  test("never quotes the build output in the failure it reports", () => {
    const output = [
      "#18 12.0 DATABASE_URL=postgres://app:hunter2@db:5432/app",
      'process "bun run build" did not complete successfully: cannot allocate memory',
    ].join("\n");

    const error = withBuildMemoryBudget(
      new BuildctlExecutionError(classifyBuildFailure({ exitCode: 1, signal: null, output })),
      builderMemoryBytes
    ) as BuildctlExecutionError;

    expect(error.kind).toBe("out-of-memory");
    expect(error.message).not.toContain("hunter2");
    expect(error.message).not.toContain("DATABASE_URL");
  });

  test("leaves an unrelated failure exactly as it was", () => {
    const buildFailure = new BuildctlExecutionError();
    const cloneFailure = new Error("Failed to clone the repository");

    expect(withBuildMemoryBudget(buildFailure, builderMemoryBytes)).toBe(buildFailure);
    expect(buildFailure.message).toBe("BuildKit build failed");
    expect(withBuildMemoryBudget(cloneFailure, builderMemoryBytes)).toBe(cloneFailure);
  });

  test("still names the failure when the builder's budget is unknown", () => {
    const error = new BuildctlExecutionError("out-of-memory");

    expect(error.message).toContain("ran out of memory");
    expect(error.message).not.toContain("MiB");
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

// The payloads below are the shape railpack 0.23.0 writes to `--info-out`: a single entry in
// `detectedProviders` plus flat string metadata, with boolean flags present only when true.
describe("resolveDetectedFramework", () => {
  test("uses the python runtime rather than repeating the provider", () => {
    expect(
      resolveDetectedFramework(["python"], {
        pythonRuntime: "fastapi",
        pythonPackageManager: "pip",
      })
    ).toBe("fastapi");
  });

  test("reports no framework for a plain python app", () => {
    expect(
      resolveDetectedFramework(["python"], {
        pythonRuntime: "python",
        pythonPackageManager: "pip",
      })
    ).toBeNull();
  });

  test("reports no framework when railpack supplies no framework signal", () => {
    expect(resolveDetectedFramework(["golang"], { goMod: "true", goRootFile: "true" })).toBeNull();
  });

  test("keeps node framework identity distinct from the provider", () => {
    expect(
      resolveDetectedFramework(["node"], {
        nodeRuntime: "next",
        nodePackageManager: "npm",
      })
    ).toBe("next");
  });

  test("does not treat a package manager runtime as a framework", () => {
    expect(
      resolveDetectedFramework(["node"], {
        nodeRuntime: "bun",
        nodePackageManager: "bun",
      })
    ).toBeNull();
  });

  test("does not treat an unattributed static build as a framework", () => {
    expect(
      resolveDetectedFramework(["node"], { nodeRuntime: "static", nodeIsSPA: "true" })
    ).toBeNull();
  });

  test("reads framework flags for providers that report booleans", () => {
    expect(resolveDetectedFramework(["golang"], { goMod: "true", goGin: "true" })).toBe("gin");
    expect(resolveDetectedFramework(["php"], { phpLaravel: "true" })).toBe("laravel");
    expect(resolveDetectedFramework(["ruby"], { rubyRails: "true" })).toBe("rails");
  });

  test("ignores metadata values that are not strings", () => {
    expect(resolveDetectedFramework(["python"], { pythonRuntime: 42, goGin: true })).toBeNull();
  });
});
