import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { type BuildLogEmitter, buildProgressEntry, streamCommand } from "./build-logs.js";
import type { DockerApiClient } from "./docker-api.js";
import type {
  AgentImageStoreMode,
  AppBuildConfig,
  AppBuildType,
  AppDockerfileBuildConfig,
  AppRailpackBuildConfig,
  AppStaticBuildConfig,
  BuildLogStage,
  ServiceResourceLimits,
} from "./protocol.js";
import { redactSensitiveText } from "./security.js";

const execFile = promisify(execFileCallback);

const RAILPACK_BIN = process.env.RAILPACK_PATH || "railpack";
const BUILDCTL_BIN = process.env.BUILDCTL_PATH || "buildctl";

const DEFAULT_APP_BUILD_ROOT = ".";
const DEFAULT_DOCKERFILE_PATH = "Dockerfile";
const DEFAULT_DOCKER_CONTEXT_PATH = ".";
const DEFAULT_STATIC_PUBLISH_DIRECTORY = "dist";

interface ResolvedAppBuildSettings {
  appBuildType: AppBuildType;
  appBuildConfig: AppBuildConfig;
}

export interface BuildAppOptions {
  docker: Pick<DockerApiClient, "inspectImage" | "loadImage">;
  repoUrl: string;
  commitHash: string;
  deploymentId: string;
  envVars: Record<string, string>;
  resourceLimits: ServiceResourceLimits | null;
  imageStoreMode: AgentImageStoreMode;
  localRegistryHost: string;
  localRegistryPort: number;
  buildkitAddress: string;
  appBuildType?: AppBuildType | null;
  appBuildConfig?: AppBuildConfig | null;
  /** Receives clone, analyze and BuildKit output as it is produced. */
  onBuildLog?: BuildLogEmitter;
}

export interface BuildAppResult {
  imageUrl: string;
  imageId: string | null;
  imageSha: string | null;
  buildDuration: number;
  detectedLanguage: string | null;
  detectedFramework: string | null;
  languageVersion: string | null;
  internalPort: number | null;
}

interface StrategyBuildResult {
  imageId: string | null;
  imageSha: string | null;
  detectedLanguage: string | null;
  detectedFramework: string | null;
  languageVersion: string | null;
  internalPort: number | null;
}

interface BuildctlImageBuildOptions {
  buildkitAddress: string;
  buildArgs?: Record<string, string>;
  contextDir: string;
  dockerfileDir: string;
  dockerfileName: string;
  output: string;
  targetStage?: string | null;
}

interface BuildImageOutput {
  archivePath: string | null;
  buildctlOutput: string;
  imageUrl: string;
}

export class BuildctlExecutionError extends Error {
  constructor() {
    super("BuildKit build failed");
    this.name = "BuildctlExecutionError";
  }
}

export function toSafeBuildctlExecutionError(error: unknown): BuildctlExecutionError {
  if (error instanceof BuildctlExecutionError) {
    return error;
  }

  return new BuildctlExecutionError();
}

interface StreamedBuildCommandOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stage: BuildLogStage;
  envVars: Record<string, string>;
  onBuildLog?: BuildLogEmitter;
}

/**
 * Runs one step of a build, forwarding its output to the deployment's build log as it is produced.
 * Every line is redacted against the service's own variables before it leaves the agent; the
 * control plane redacts again on ingest.
 */
async function runStreamedBuildCommand(
  options: StreamedBuildCommandOptions
): Promise<{ stdout: string; stderr: string }> {
  const onBuildLog = options.onBuildLog;
  const result = await streamCommand({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    env: options.env,
    onLine: onBuildLog
      ? (line, stream) => {
          onBuildLog({
            type: stream,
            line: redactSensitiveText(line, options.envVars),
            timestamp: Date.now(),
            stage: options.stage,
          });
        }
      : undefined,
  });

  if (result.exitCode !== 0 || result.signal !== null) {
    onBuildLog?.({
      type: "stderr",
      line: result.signal
        ? `[nouva] ${options.stage} step terminated with signal ${result.signal}`
        : `[nouva] ${options.stage} step exited with code ${result.exitCode}`,
      timestamp: Date.now(),
      stage: options.stage,
    });
    throw new BuildctlExecutionError();
  }

  return { stdout: result.stdout, stderr: result.stderr };
}

function buildEnvVars(envVars: Record<string, string>): Record<string, string> {
  return {
    ...process.env,
    NODE_ENV: "production",
    ...envVars,
  };
}

function normalizeRepoRelativePath(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "/" || trimmed === "./" || trimmed === ".") {
    return fallback;
  }

  const normalized = trimmed.replace(/^\.\/+/, "").replace(/^\/+|\/+$/g, "");
  return normalized.length > 0 ? normalized : fallback;
}

export function normalizeAppBuildSettings(
  appBuildType: AppBuildType | null | undefined,
  appBuildConfig: AppBuildConfig | null | undefined
): ResolvedAppBuildSettings {
  const resolvedBuildType = appBuildType ?? "railpack";

  switch (resolvedBuildType) {
    case "dockerfile": {
      const config = (appBuildConfig ?? {}) as Partial<AppDockerfileBuildConfig>;
      const buildRoot = normalizeRepoRelativePath(config.buildRoot, DEFAULT_APP_BUILD_ROOT);

      return {
        appBuildType: resolvedBuildType,
        appBuildConfig: {
          buildRoot,
          dockerfilePath: normalizeRepoRelativePath(config.dockerfilePath, DEFAULT_DOCKERFILE_PATH),
          dockerContextPath: normalizeRepoRelativePath(
            config.dockerContextPath,
            DEFAULT_DOCKER_CONTEXT_PATH
          ),
          dockerBuildStage: config.dockerBuildStage?.trim() || null,
        },
      };
    }
    case "static": {
      const config = (appBuildConfig ?? {}) as Partial<AppStaticBuildConfig>;
      return {
        appBuildType: resolvedBuildType,
        appBuildConfig: {
          buildRoot: normalizeRepoRelativePath(config.buildRoot, DEFAULT_APP_BUILD_ROOT),
          publishDirectory: normalizeRepoRelativePath(
            config.publishDirectory,
            DEFAULT_STATIC_PUBLISH_DIRECTORY
          ),
          spaFallback: config.spaFallback ?? false,
        },
      };
    }
    default: {
      const config = (appBuildConfig ?? {}) as Partial<AppRailpackBuildConfig>;
      return {
        appBuildType: "railpack",
        appBuildConfig: {
          buildRoot: normalizeRepoRelativePath(config.buildRoot, DEFAULT_APP_BUILD_ROOT),
        },
      };
    }
  }
}

function extractImageSha(output: string): string | null {
  const match = output.match(/sha256:[a-f0-9]{64}/);
  return match ? match[0] : null;
}

async function cloneRepository(
  repoUrl: string,
  commitHash: string,
  targetDir: string,
  onBuildLog?: BuildLogEmitter
): Promise<void> {
  try {
    await execFile("git", ["clone", "--depth", "1", repoUrl, targetDir]);
    await execFile("git", ["-C", targetDir, "fetch", "--depth", "1", "origin", commitHash]);
    await execFile("git", ["-C", targetDir, "checkout", commitHash]);
  } catch {
    await rm(targetDir, { recursive: true, force: true });
    try {
      await execFile("git", ["clone", repoUrl, targetDir]);
      await execFile("git", ["-C", targetDir, "checkout", commitHash]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Repository clone failed";
      const safeMessage = redactSensitiveText(message);
      onBuildLog?.({
        type: "stderr",
        line: safeMessage,
        timestamp: Date.now(),
        stage: "cloning",
      });
      throw new Error(safeMessage);
    }
  }
}

/**
 * Delete the checkout's git metadata before anything reads the tree as a build context.
 *
 * Every strategy hands a directory under `repoDir` to buildctl as `--local context=`, and railpack's
 * generated plan copies that context wholesale into `/app`. Without this the shipped image carries
 * the full history, the remote URL (including any credentials baked into it), the reflog and any
 * hooks. Nothing downstream needs it: the commit being built is control-plane supplied via
 * `payload.commitHash`, never read back out of `.git`.
 *
 * `.git` is a file rather than a directory in a worktree checkout, so this removes either.
 */
export async function stripRepositoryGitMetadata(repoDir: string): Promise<void> {
  await rm(path.join(repoDir, ".git"), { recursive: true, force: true });
}

/**
 * Railpack metadata keys whose value names the framework, in provider order.
 *
 * Railpack plans with exactly one language provider per build, so at most one of these is ever
 * present in a single info payload; the order only settles a hypothetical tie.
 */
const RAILPACK_FRAMEWORK_RUNTIME_KEYS = ["pythonRuntime", "nodeRuntime", "javaFramework"] as const;

/**
 * Railpack framework flags, which are only emitted when true, mapped to the framework they mean.
 */
const RAILPACK_FRAMEWORK_FLAGS: ReadonlyArray<readonly [key: string, framework: string]> = [
  ["goGin", "gin"],
  ["phpLaravel", "laravel"],
  ["rubyRails", "rails"],
];

/**
 * Runtime values that name a packaging choice rather than a framework. Railpack falls back to the
 * provider name (`python`, `node`) when it recognizes no framework, reports `bun` when Bun is
 * merely the package manager, and reports `static` for a single-page app it could not attribute.
 */
const RAILPACK_NON_FRAMEWORK_RUNTIMES = new Set(["bun", "static"]);

/**
 * Resolve the framework Railpack detected, or null when it detected none.
 *
 * A provider is not a framework. Railpack reports exactly one entry in `detectedProviders` (its
 * `BuildResult` is built from a single detected provider name), so the previous
 * `providers[1] ?? providers[0]` fallback could never do anything but repeat the language — every
 * Railpack deployment rendered as `python / python`, `node / node` and so on. The framework is
 * carried separately in `metadata`, either as a runtime string or as a boolean flag.
 */
export function resolveDetectedFramework(
  providers: readonly string[],
  metadata: Record<string, unknown>
): string | null {
  for (const key of RAILPACK_FRAMEWORK_RUNTIME_KEYS) {
    const runtime = metadata[key];
    if (typeof runtime !== "string") {
      continue;
    }

    const framework = runtime.trim();
    const normalized = framework.toLowerCase();
    if (!framework || RAILPACK_NON_FRAMEWORK_RUNTIMES.has(normalized)) {
      continue;
    }

    if (providers.some((provider) => provider.toLowerCase() === normalized)) {
      continue;
    }

    return framework;
  }

  for (const [key, framework] of RAILPACK_FRAMEWORK_FLAGS) {
    if (metadata[key] === "true") {
      return framework;
    }
  }

  return null;
}

function inferBuildMetadata(info: Record<string, unknown>): {
  detectedLanguage: string | null;
  detectedFramework: string | null;
  languageVersion: string | null;
  internalPort: number | null;
} {
  const providers = Array.isArray(info.detectedProviders)
    ? info.detectedProviders.filter((value): value is string => typeof value === "string")
    : [];
  const metadata =
    typeof info.metadata === "object" && info.metadata !== null
      ? (info.metadata as Record<string, string>)
      : {};

  const portCandidate = metadata.PORT || metadata.port || metadata.APP_PORT || metadata.app_port;
  const parsedPort = portCandidate ? Number(portCandidate) : null;

  return {
    detectedLanguage: providers[0] ?? null,
    detectedFramework: resolveDetectedFramework(providers, metadata),
    languageVersion:
      metadata.NODE_VERSION ??
      metadata.PYTHON_VERSION ??
      metadata.GO_VERSION ??
      metadata.RUBY_VERSION ??
      null,
    internalPort:
      parsedPort && Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535
        ? parsedPort
        : null,
  };
}

function resolveBuildRootDirectory(repoDir: string, buildRoot: string): string {
  return buildRoot === "." ? repoDir : path.join(repoDir, buildRoot);
}

function resolvePathWithinBuildRoot(buildRootDir: string, relativePath: string): string {
  return relativePath === "." ? buildRootDir : path.join(buildRootDir, relativePath);
}

function buildRegistryImageUrl(options: {
  deploymentId: string;
  localRegistryHost: string;
  localRegistryPort: number;
  suffix?: string;
}): string {
  const imageTag = options.suffix
    ? `nouva-app:${options.deploymentId}-${options.suffix}`
    : `nouva-app:${options.deploymentId}`;
  return `${options.localRegistryHost}:${options.localRegistryPort}/${imageTag}`;
}

function buildLocalImageUrl(options: { deploymentId: string; suffix?: string }): string {
  return options.suffix
    ? `nouva-app:${options.deploymentId}-${options.suffix}`
    : `nouva-app:${options.deploymentId}`;
}

function buildImageUrl(options: {
  deploymentId: string;
  imageStoreMode: AgentImageStoreMode;
  localRegistryHost: string;
  localRegistryPort: number;
  suffix?: string;
}): string {
  return options.imageStoreMode === "local-registry"
    ? buildRegistryImageUrl(options)
    : buildLocalImageUrl(options);
}

function createBuildImageOutput(options: {
  tempRoot: string;
  imageUrl: string;
  imageStoreMode: AgentImageStoreMode;
}): BuildImageOutput {
  if (options.imageStoreMode === "local-registry") {
    return {
      archivePath: null,
      buildctlOutput: `type=image,name=${options.imageUrl},push=true,registry.insecure=true,registry.http=true`,
      imageUrl: options.imageUrl,
    };
  }

  const sanitizedImageName = options.imageUrl.replace(/[^a-zA-Z0-9_.-]+/g, "-");
  const archivePath = path.join(options.tempRoot, `${sanitizedImageName}.tar`);
  return {
    archivePath,
    buildctlOutput: `type=docker,name=${options.imageUrl},dest=${archivePath}`,
    imageUrl: options.imageUrl,
  };
}

function buildLocalDirectoryOutput(destDir: string): string {
  return `type=local,dest=${destDir}`;
}

export function buildRailpackBuildctlArgs(options: {
  buildkitAddress: string;
  buildRootDir: string;
  planDir: string;
  planFileName: string;
  output: string;
  envVarKeys?: string[];
}): string[] {
  if (path.resolve(options.planDir) === path.resolve(options.buildRootDir)) {
    throw new Error("railpack plan directory must not be the build context");
  }
  const args = [
    "--addr",
    options.buildkitAddress,
    "build",
    // Plain progress is one line per step on stderr, which is what makes the build streamable.
    "--progress",
    "plain",
    "--frontend",
    "gateway.v0",
    "--opt",
    "source=ghcr.io/railwayapp/railpack-frontend:latest",
    "--opt",
    `filename=${options.planFileName}`,
    "--local",
    `context=${options.buildRootDir}`,
    // The plan lists every service env var name under `secrets`, and railpack copies the whole
    // context into the image, so the plan and info files live in their own local that only the
    // frontend reads. Otherwise they ship inside the app image at /app.
    "--local",
    `dockerfile=${options.planDir}`,
    "--output",
    options.output,
    "--opt",
    "platform=linux/amd64",
  ];

  for (const key of options.envVarKeys ?? []) {
    args.push("--secret", `id=${key},env=${key}`);
  }

  return args;
}

export function buildDockerfileBuildctlArgs(options: BuildctlImageBuildOptions): string[] {
  const args = [
    "--addr",
    options.buildkitAddress,
    "build",
    // Plain progress is one line per step on stderr, which is what makes the build streamable.
    "--progress",
    "plain",
    "--frontend",
    "dockerfile.v0",
    "--local",
    `context=${options.contextDir}`,
    "--local",
    `dockerfile=${options.dockerfileDir}`,
    "--output",
    options.output,
    "--opt",
    `filename=${options.dockerfileName}`,
    "--opt",
    "platform=linux/amd64",
  ];

  for (const key of Object.keys(options.buildArgs ?? {}).sort()) {
    args.push("--opt", `build-arg:${key}=${options.buildArgs![key]}`);
  }

  if (options.targetStage) {
    args.push("--opt", `target=${options.targetStage}`);
  }

  return args;
}

async function runBuildctlBuild(
  options: BuildctlImageBuildOptions,
  env: NodeJS.ProcessEnv = process.env,
  logging: { onBuildLog?: BuildLogEmitter; envVars?: Record<string, string> } = {}
): Promise<string | null> {
  try {
    const { stdout, stderr } = await runStreamedBuildCommand({
      command: BUILDCTL_BIN,
      args: buildDockerfileBuildctlArgs(options),
      cwd: options.contextDir,
      env,
      stage: "building",
      envVars: logging.envVars ?? {},
      ...(logging.onBuildLog ? { onBuildLog: logging.onBuildLog } : {}),
    });

    return extractImageSha(`${stdout}\n${stderr}`);
  } catch (error) {
    throw toSafeBuildctlExecutionError(error);
  }
}

async function loadBuiltImageIfNeeded(
  docker: Pick<DockerApiClient, "inspectImage" | "loadImage">,
  output: BuildImageOutput
): Promise<string | null> {
  if (!output.archivePath) {
    return null;
  }

  const archive = await readFile(output.archivePath);
  await docker.loadImage(archive);
  const inspection = await docker.inspectImage(output.imageUrl);
  return inspection?.Id ?? null;
}

async function prepareRailpackPlan(
  buildRootDir: string,
  planDir: string,
  envVars: Record<string, string>,
  onBuildLog?: BuildLogEmitter
): Promise<{
  childEnv: NodeJS.ProcessEnv;
  info: Record<string, unknown>;
  planFileName: string;
}> {
  const childEnv = buildEnvVars(envVars);
  const infoFileName = "railpack-info.json";
  const planFileName = "railpack-plan.json";
  const planFile = path.join(planDir, planFileName);
  const infoFile = path.join(planDir, infoFileName);

  // Both files are written outside the build context: the plan names every env var as a build
  // secret and railpack copies the context wholesale into the image.
  const prepareArgs = ["prepare", "--plan-out", planFile, "--info-out", infoFile];
  for (const key of Object.keys(envVars)) {
    prepareArgs.push("--env", `${key}=\${${key}}`);
  }
  prepareArgs.push(buildRootDir);

  onBuildLog?.(buildProgressEntry("analyzing", "Analyzing the repository", 20));
  await runStreamedBuildCommand({
    command: RAILPACK_BIN,
    args: prepareArgs,
    cwd: buildRootDir,
    env: childEnv,
    stage: "analyzing",
    envVars,
    ...(onBuildLog ? { onBuildLog } : {}),
  });

  const infoRaw = await readFile(infoFile, "utf8");
  return {
    childEnv,
    info: JSON.parse(infoRaw) as Record<string, unknown>,
    planFileName,
  };
}

async function runRailpackBuildctl(options: {
  buildRootDir: string;
  planDir: string;
  buildkitAddress: string;
  childEnv: NodeJS.ProcessEnv;
  envVars: Record<string, string>;
  envVarKeys: string[];
  output: string;
  planFileName: string;
  onBuildLog?: BuildLogEmitter;
}): Promise<string | null> {
  try {
    const { stdout, stderr } = await runStreamedBuildCommand({
      command: BUILDCTL_BIN,
      args: buildRailpackBuildctlArgs({
        buildkitAddress: options.buildkitAddress,
        buildRootDir: options.buildRootDir,
        planDir: options.planDir,
        planFileName: options.planFileName,
        output: options.output,
        envVarKeys: options.envVarKeys,
      }),
      cwd: options.buildRootDir,
      env: options.childEnv,
      stage: "building",
      envVars: options.envVars,
      ...(options.onBuildLog ? { onBuildLog: options.onBuildLog } : {}),
    });

    return extractImageSha(`${stdout}\n${stderr}`);
  } catch (error) {
    throw toSafeBuildctlExecutionError(error);
  }
}

// Prepares the railpack plan in a private temporary directory, runs the build, and removes the
// plan afterwards. The plan directory is the frontend's `dockerfile` local, never the context.
async function runRailpackBuild(options: {
  buildRootDir: string;
  envVars: Record<string, string>;
  buildkitAddress: string;
  output: string;
  onBuildLog?: BuildLogEmitter;
}): Promise<{ imageSha: string | null; info: Record<string, unknown> }> {
  const planDir = await mkdtemp(path.join(os.tmpdir(), "nouva-railpack-plan-"));
  try {
    const prepared = await prepareRailpackPlan(
      options.buildRootDir,
      planDir,
      options.envVars,
      options.onBuildLog
    );
    options.onBuildLog?.(buildProgressEntry("building", "Building the image", 40));
    const imageSha = await runRailpackBuildctl({
      buildRootDir: options.buildRootDir,
      planDir,
      buildkitAddress: options.buildkitAddress,
      childEnv: prepared.childEnv,
      envVars: options.envVars,
      envVarKeys: Object.keys(options.envVars),
      output: options.output,
      planFileName: prepared.planFileName,
      ...(options.onBuildLog ? { onBuildLog: options.onBuildLog } : {}),
    });
    return { imageSha, info: prepared.info };
  } finally {
    await rm(planDir, { recursive: true, force: true });
  }
}

async function buildRailpackApplication(options: {
  docker: Pick<DockerApiClient, "inspectImage" | "loadImage">;
  buildRootDir: string;
  envVars: Record<string, string>;
  buildkitAddress: string;
  output: BuildImageOutput;
  onBuildLog?: BuildLogEmitter;
}): Promise<StrategyBuildResult> {
  const built = await runRailpackBuild({
    buildRootDir: options.buildRootDir,
    envVars: options.envVars,
    buildkitAddress: options.buildkitAddress,
    output: options.output.buildctlOutput,
    ...(options.onBuildLog ? { onBuildLog: options.onBuildLog } : {}),
  });
  const imageId = await loadBuiltImageIfNeeded(options.docker, options.output);

  return {
    imageId,
    imageSha: built.imageSha,
    ...inferBuildMetadata(built.info),
  };
}

export function detectDockerfileExposedPort(dockerfileSource: string): number | null {
  let detectedPort: number | null = null;

  for (const line of dockerfileSource.split(/\r?\n/)) {
    const sanitized = line.replace(/#.*/, "").trim();
    if (!sanitized.toUpperCase().startsWith("EXPOSE ")) {
      continue;
    }

    const values = sanitized.slice("EXPOSE ".length).trim().split(/\s+/);
    for (const value of values) {
      const match = value.match(/^(\d{1,5})(?:\/tcp)?$/i);
      if (!match) {
        continue;
      }

      const port = Number(match[1]);
      if (Number.isInteger(port) && port >= 1 && port <= 65535) {
        detectedPort = port;
        break;
      }
    }
  }

  return detectedPort;
}

async function buildDockerfileApplication(options: {
  docker: Pick<DockerApiClient, "inspectImage" | "loadImage">;
  buildRootDir: string;
  dockerfilePath: string;
  dockerContextPath: string;
  dockerBuildStage?: string | null;
  envVars: Record<string, string>;
  buildkitAddress: string;
  output: BuildImageOutput;
  onBuildLog?: BuildLogEmitter;
}): Promise<StrategyBuildResult> {
  const dockerfileAbsolutePath = resolvePathWithinBuildRoot(
    options.buildRootDir,
    options.dockerfilePath
  );
  const contextDir = resolvePathWithinBuildRoot(options.buildRootDir, options.dockerContextPath);
  const dockerfileSource = await readFile(dockerfileAbsolutePath, "utf8");

  options.onBuildLog?.(buildProgressEntry("building", "Building the image", 40));
  const imageSha = await runBuildctlBuild(
    {
      buildkitAddress: options.buildkitAddress,
      buildArgs: options.envVars,
      contextDir,
      dockerfileDir: path.dirname(dockerfileAbsolutePath),
      dockerfileName: path.basename(dockerfileAbsolutePath),
      output: options.output.buildctlOutput,
      targetStage: options.dockerBuildStage ?? null,
    },
    buildEnvVars(options.envVars),
    {
      envVars: options.envVars,
      ...(options.onBuildLog ? { onBuildLog: options.onBuildLog } : {}),
    }
  );
  const imageId = await loadBuiltImageIfNeeded(options.docker, options.output);

  return {
    imageId,
    imageSha,
    detectedLanguage: null,
    detectedFramework: null,
    languageVersion: null,
    internalPort: detectDockerfileExposedPort(dockerfileSource),
  };
}

function resolveContainerPublishDirectory(publishDirectory: string): string {
  const normalized = normalizeRepoRelativePath(publishDirectory, ".");
  if (normalized === ".") {
    return "/app";
  }

  return path.posix.join("/app", normalized);
}

export function buildStaticNginxConfig(spaFallback: boolean): string {
  const fallback = spaFallback ? "/index.html" : "=404";

  return [
    "server {",
    "  listen 80;",
    "  server_name _;",
    "  root /usr/share/nginx/html;",
    "  index index.html;",
    "  location / {",
    `    try_files $uri $uri/ ${fallback};`,
    "  }",
    "}",
    "",
  ].join("\n");
}

export function buildStaticRuntimeDockerfile(options: {
  intermediateImageUrl?: string;
  publishDirectoryInContext?: string;
  publishDirectoryInImage?: string;
  spaFallback: boolean;
}): string {
  const copyInstruction =
    options.intermediateImageUrl && options.publishDirectoryInImage
      ? `COPY --from=${options.intermediateImageUrl} ${options.publishDirectoryInImage}/ /usr/share/nginx/html/`
      : options.publishDirectoryInContext
        ? `COPY ${options.publishDirectoryInContext}/ /usr/share/nginx/html/`
        : null;

  if (!copyInstruction) {
    throw new Error("Static runtime Dockerfile requires an image source or build-context source");
  }

  const lines = ["FROM nginx:1.27-alpine", copyInstruction, "EXPOSE 80"];

  if (options.spaFallback) {
    lines.splice(2, 0, "COPY nginx.conf /etc/nginx/conf.d/default.conf");
  }

  return `${lines.join("\n")}\n`;
}

async function buildStaticApplication(options: {
  docker: Pick<DockerApiClient, "inspectImage" | "loadImage">;
  tempRoot: string;
  buildRootDir: string;
  publishDirectory: string;
  spaFallback: boolean;
  envVars: Record<string, string>;
  buildkitAddress: string;
  deploymentId: string;
  imageStoreMode: AgentImageStoreMode;
  localRegistryHost: string;
  localRegistryPort: number;
  output: BuildImageOutput;
  onBuildLog?: BuildLogEmitter;
}): Promise<StrategyBuildResult> {
  const runtimeDir = path.join(options.tempRoot, "static-runtime");
  await mkdir(runtimeDir, { recursive: true });
  const publishDirectoryInImage = resolveContainerPublishDirectory(options.publishDirectory);

  let detectedLanguage: string | null = null;
  let detectedFramework: string | null = null;
  let languageVersion: string | null = null;

  if (options.imageStoreMode === "docker-local") {
    const staticExportDir = path.join(runtimeDir, "static-export");
    await mkdir(staticExportDir, { recursive: true });

    const built = await runRailpackBuild({
      buildRootDir: options.buildRootDir,
      envVars: options.envVars,
      buildkitAddress: options.buildkitAddress,
      output: buildLocalDirectoryOutput(staticExportDir),
      ...(options.onBuildLog ? { onBuildLog: options.onBuildLog } : {}),
    });

    const metadata = inferBuildMetadata(built.info);
    detectedLanguage = metadata.detectedLanguage;
    detectedFramework = metadata.detectedFramework;
    languageVersion = metadata.languageVersion;

    await writeFile(
      path.join(runtimeDir, "Dockerfile"),
      buildStaticRuntimeDockerfile({
        publishDirectoryInContext: path.posix.join(
          "static-export",
          publishDirectoryInImage.replace(/^\/+/, "")
        ),
        spaFallback: options.spaFallback,
      }),
      "utf8"
    );
  } else {
    const intermediateImageUrl = buildImageUrl({
      deploymentId: options.deploymentId,
      imageStoreMode: options.imageStoreMode,
      localRegistryHost: options.localRegistryHost,
      localRegistryPort: options.localRegistryPort,
      suffix: "static-build",
    });

    const railpackResult = await buildRailpackApplication({
      docker: options.docker,
      buildRootDir: options.buildRootDir,
      envVars: options.envVars,
      buildkitAddress: options.buildkitAddress,
      output: createBuildImageOutput({
        tempRoot: options.tempRoot,
        imageUrl: intermediateImageUrl,
        imageStoreMode: options.imageStoreMode,
      }),
      ...(options.onBuildLog ? { onBuildLog: options.onBuildLog } : {}),
    });

    detectedLanguage = railpackResult.detectedLanguage;
    detectedFramework = railpackResult.detectedFramework;
    languageVersion = railpackResult.languageVersion;

    await writeFile(
      path.join(runtimeDir, "Dockerfile"),
      buildStaticRuntimeDockerfile({
        intermediateImageUrl,
        publishDirectoryInImage,
        spaFallback: options.spaFallback,
      }),
      "utf8"
    );
  }

  await writeFile(
    path.join(runtimeDir, "nginx.conf"),
    buildStaticNginxConfig(options.spaFallback),
    "utf8"
  );

  const imageSha = await runBuildctlBuild(
    {
      buildkitAddress: options.buildkitAddress,
      contextDir: runtimeDir,
      dockerfileDir: runtimeDir,
      dockerfileName: "Dockerfile",
      output: options.output.buildctlOutput,
    },
    process.env,
    {
      envVars: options.envVars,
      ...(options.onBuildLog ? { onBuildLog: options.onBuildLog } : {}),
    }
  );
  const imageId = await loadBuiltImageIfNeeded(options.docker, options.output);

  return {
    imageId,
    imageSha,
    detectedLanguage,
    detectedFramework,
    languageVersion,
    internalPort: 80,
  };
}

export async function buildApp(options: BuildAppOptions): Promise<BuildAppResult> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), `nouva-agent-${options.deploymentId}-`));
  const repoDir = path.join(tempRoot, "repo");
  const buildStart = Date.now();
  const onBuildLog = options.onBuildLog;

  try {
    onBuildLog?.(buildProgressEntry("cloning", "Cloning the repository", 5));
    await cloneRepository(options.repoUrl, options.commitHash, repoDir, onBuildLog);
    // After the last git command and before any directory under `repoDir` becomes a build context.
    await stripRepositoryGitMetadata(repoDir);
    onBuildLog?.({
      type: "stdout",
      line: `[nouva] checked out ${options.commitHash}`,
      timestamp: Date.now(),
      stage: "cloning",
    });

    const buildSettings = normalizeAppBuildSettings(options.appBuildType, options.appBuildConfig);
    const imageUrl = buildImageUrl({
      deploymentId: options.deploymentId,
      imageStoreMode: options.imageStoreMode,
      localRegistryHost: options.localRegistryHost,
      localRegistryPort: options.localRegistryPort,
    });
    const output = createBuildImageOutput({
      tempRoot,
      imageUrl,
      imageStoreMode: options.imageStoreMode,
    });
    const buildRootDir = resolveBuildRootDirectory(repoDir, buildSettings.appBuildConfig.buildRoot);

    let result: StrategyBuildResult;

    switch (buildSettings.appBuildType) {
      case "dockerfile": {
        const config = buildSettings.appBuildConfig as AppDockerfileBuildConfig;
        result = await buildDockerfileApplication({
          docker: options.docker,
          buildRootDir,
          dockerfilePath: config.dockerfilePath,
          dockerContextPath: config.dockerContextPath,
          dockerBuildStage: config.dockerBuildStage ?? null,
          envVars: options.envVars,
          buildkitAddress: options.buildkitAddress,
          output,
          ...(onBuildLog ? { onBuildLog } : {}),
        });
        break;
      }
      case "static": {
        const config = buildSettings.appBuildConfig as AppStaticBuildConfig;
        result = await buildStaticApplication({
          docker: options.docker,
          tempRoot,
          buildRootDir,
          publishDirectory: config.publishDirectory,
          spaFallback: config.spaFallback,
          envVars: options.envVars,
          buildkitAddress: options.buildkitAddress,
          deploymentId: options.deploymentId,
          imageStoreMode: options.imageStoreMode,
          localRegistryHost: options.localRegistryHost,
          localRegistryPort: options.localRegistryPort,
          output,
          ...(onBuildLog ? { onBuildLog } : {}),
        });
        break;
      }
      default:
        result = await buildRailpackApplication({
          docker: options.docker,
          buildRootDir,
          envVars: options.envVars,
          buildkitAddress: options.buildkitAddress,
          output,
          ...(onBuildLog ? { onBuildLog } : {}),
        });
        break;
    }

    onBuildLog?.(buildProgressEntry("pushing", "Publishing the image", 80));

    return {
      imageUrl,
      buildDuration: Date.now() - buildStart,
      ...result,
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export function hashProjectNetwork(projectId: string): string {
  return createHash("sha256").update(projectId).digest("hex").slice(0, 12);
}
