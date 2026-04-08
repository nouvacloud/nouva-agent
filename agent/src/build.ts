import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DockerApiClient } from "./docker-api.js";
import type {
  AgentImageStoreMode,
  AppBuildConfig,
  AppBuildType,
  AppDockerfileBuildConfig,
  AppRailpackBuildConfig,
  AppStaticBuildConfig,
  ServiceResourceLimits,
} from "./protocol.js";

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
  targetDir: string
): Promise<void> {
  try {
    await execFile("git", ["clone", "--depth", "1", repoUrl, targetDir]);
    await execFile("git", ["-C", targetDir, "fetch", "--depth", "1", "origin", commitHash]);
    await execFile("git", ["-C", targetDir, "checkout", commitHash]);
  } catch {
    await rm(targetDir, { recursive: true, force: true });
    await execFile("git", ["clone", repoUrl, targetDir]);
    await execFile("git", ["-C", targetDir, "checkout", commitHash]);
  }
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
    detectedFramework: providers[1] ?? providers[0] ?? null,
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
  planFileName: string;
  output: string;
  envVarKeys?: string[];
}): string[] {
  const args = [
    "--addr",
    options.buildkitAddress,
    "build",
    "--frontend",
    "gateway.v0",
    "--opt",
    "source=ghcr.io/railwayapp/railpack-frontend:latest",
    "--opt",
    `filename=${options.planFileName}`,
    "--local",
    `context=${options.buildRootDir}`,
    "--local",
    `dockerfile=${options.buildRootDir}`,
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
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  const { stdout, stderr } = await execFile(BUILDCTL_BIN, buildDockerfileBuildctlArgs(options), {
    cwd: options.contextDir,
    env,
    maxBuffer: 1024 * 1024 * 32,
  });

  return extractImageSha(`${stdout}\n${stderr}`);
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
  envVars: Record<string, string>
): Promise<{
  childEnv: NodeJS.ProcessEnv;
  info: Record<string, unknown>;
  planFileName: string;
}> {
  const childEnv = buildEnvVars(envVars);
  const infoFileName = "railpack-info.json";
  const planFileName = "railpack-plan.json";
  const infoFile = path.join(buildRootDir, infoFileName);

  const prepareArgs = ["prepare", "--plan-out", planFileName, "--info-out", infoFileName];
  for (const key of Object.keys(envVars)) {
    prepareArgs.push("--env", `${key}=\${${key}}`);
  }
  prepareArgs.push(buildRootDir);

  await execFile(RAILPACK_BIN, prepareArgs, {
    cwd: buildRootDir,
    env: childEnv,
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
  buildkitAddress: string;
  childEnv: NodeJS.ProcessEnv;
  envVarKeys: string[];
  output: string;
  planFileName: string;
}): Promise<string | null> {
  const { stdout, stderr } = await execFile(
    BUILDCTL_BIN,
    buildRailpackBuildctlArgs({
      buildkitAddress: options.buildkitAddress,
      buildRootDir: options.buildRootDir,
      planFileName: options.planFileName,
      output: options.output,
      envVarKeys: options.envVarKeys,
    }),
    {
      cwd: options.buildRootDir,
      env: options.childEnv,
      maxBuffer: 1024 * 1024 * 32,
    }
  );

  return extractImageSha(`${stdout}\n${stderr}`);
}

async function buildRailpackApplication(options: {
  docker: Pick<DockerApiClient, "inspectImage" | "loadImage">;
  buildRootDir: string;
  envVars: Record<string, string>;
  buildkitAddress: string;
  output: BuildImageOutput;
}): Promise<StrategyBuildResult> {
  const prepared = await prepareRailpackPlan(options.buildRootDir, options.envVars);
  const imageSha = await runRailpackBuildctl({
    buildRootDir: options.buildRootDir,
    buildkitAddress: options.buildkitAddress,
    childEnv: prepared.childEnv,
    envVarKeys: Object.keys(options.envVars),
    output: options.output.buildctlOutput,
    planFileName: prepared.planFileName,
  });
  const imageId = await loadBuiltImageIfNeeded(options.docker, options.output);

  return {
    imageId,
    imageSha,
    ...inferBuildMetadata(prepared.info),
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
}): Promise<StrategyBuildResult> {
  const dockerfileAbsolutePath = resolvePathWithinBuildRoot(
    options.buildRootDir,
    options.dockerfilePath
  );
  const contextDir = resolvePathWithinBuildRoot(options.buildRootDir, options.dockerContextPath);
  const dockerfileSource = await readFile(dockerfileAbsolutePath, "utf8");

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
    buildEnvVars(options.envVars)
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

    const prepared = await prepareRailpackPlan(options.buildRootDir, options.envVars);
    await runRailpackBuildctl({
      buildRootDir: options.buildRootDir,
      buildkitAddress: options.buildkitAddress,
      childEnv: prepared.childEnv,
      envVarKeys: Object.keys(options.envVars),
      output: buildLocalDirectoryOutput(staticExportDir),
      planFileName: prepared.planFileName,
    });

    const metadata = inferBuildMetadata(prepared.info);
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

  const imageSha = await runBuildctlBuild({
    buildkitAddress: options.buildkitAddress,
    contextDir: runtimeDir,
    dockerfileDir: runtimeDir,
    dockerfileName: "Dockerfile",
    output: options.output.buildctlOutput,
  });
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

  try {
    await cloneRepository(options.repoUrl, options.commitHash, repoDir);

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
        });
        break;
    }

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
