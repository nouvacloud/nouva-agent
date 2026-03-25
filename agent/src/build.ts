import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AppBuildConfig,
  AppBuildType,
  AppDockerfileBuildConfig,
  AppRailpackBuildConfig,
  AppStaticBuildConfig,
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
  repoUrl: string;
  commitHash: string;
  deploymentId: string;
  envVars: Record<string, string>;
  localRegistryHost: string;
  localRegistryPort: number;
  buildkitAddress: string;
  appBuildType?: AppBuildType | null;
  appBuildConfig?: AppBuildConfig | null;
}

export interface BuildAppResult {
  imageUrl: string;
  imageSha: string | null;
  buildDuration: number;
  detectedLanguage: string | null;
  detectedFramework: string | null;
  languageVersion: string | null;
  internalPort: number | null;
}

interface StrategyBuildResult {
  imageSha: string | null;
  detectedLanguage: string | null;
  detectedFramework: string | null;
  languageVersion: string | null;
  internalPort: number | null;
}

interface BuildctlImageBuildOptions {
  buildkitAddress: string;
  contextDir: string;
  dockerfileDir: string;
  dockerfileName: string;
  imageUrl: string;
  targetStage?: string | null;
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
          dockerfilePath: normalizeRepoRelativePath(
            config.dockerfilePath,
            DEFAULT_DOCKERFILE_PATH
          ),
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
    case "railpack":
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

export function buildRailpackBuildctlArgs(options: {
  buildkitAddress: string;
  buildRootDir: string;
  planFileName: string;
  imageUrl: string;
}): string[] {
  return [
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
    `type=image,name=${options.imageUrl},push=true,registry.insecure=true,registry.http=true`,
    "--opt",
    "platform=linux/amd64",
  ];
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
    `type=image,name=${options.imageUrl},push=true,registry.insecure=true,registry.http=true`,
    "--opt",
    `filename=${options.dockerfileName}`,
    "--opt",
    "platform=linux/amd64",
  ];

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

async function buildRailpackApplication(options: {
  buildRootDir: string;
  envVars: Record<string, string>;
  buildkitAddress: string;
  imageUrl: string;
}): Promise<StrategyBuildResult> {
  const childEnv = buildEnvVars(options.envVars);
  const infoFileName = "railpack-info.json";
  const planFileName = "railpack-plan.json";
  const infoFile = path.join(options.buildRootDir, infoFileName);

  const prepareArgs = ["prepare", "--plan-out", planFileName, "--info-out", infoFileName];
  for (const key of Object.keys(options.envVars)) {
    prepareArgs.push("--env", `${key}=\${${key}}`);
  }
  prepareArgs.push(options.buildRootDir);

  await execFile(RAILPACK_BIN, prepareArgs, {
    cwd: options.buildRootDir,
    env: childEnv,
  });

  const infoRaw = await readFile(infoFile, "utf8");
  const info = JSON.parse(infoRaw) as Record<string, unknown>;
  const { stdout, stderr } = await execFile(
    BUILDCTL_BIN,
    buildRailpackBuildctlArgs({
      buildkitAddress: options.buildkitAddress,
      buildRootDir: options.buildRootDir,
      planFileName,
      imageUrl: options.imageUrl,
    }),
    {
      cwd: options.buildRootDir,
      env: childEnv,
      maxBuffer: 1024 * 1024 * 32,
    }
  );

  return {
    imageSha: extractImageSha(`${stdout}\n${stderr}`),
    ...inferBuildMetadata(info),
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
  buildRootDir: string;
  dockerfilePath: string;
  dockerContextPath: string;
  dockerBuildStage?: string | null;
  envVars: Record<string, string>;
  buildkitAddress: string;
  imageUrl: string;
}): Promise<StrategyBuildResult> {
  const dockerfileAbsolutePath = resolvePathWithinBuildRoot(options.buildRootDir, options.dockerfilePath);
  const contextDir = resolvePathWithinBuildRoot(options.buildRootDir, options.dockerContextPath);
  const dockerfileSource = await readFile(dockerfileAbsolutePath, "utf8");

  const imageSha = await runBuildctlBuild(
    {
      buildkitAddress: options.buildkitAddress,
      contextDir,
      dockerfileDir: path.dirname(dockerfileAbsolutePath),
      dockerfileName: path.basename(dockerfileAbsolutePath),
      imageUrl: options.imageUrl,
      targetStage: options.dockerBuildStage ?? null,
    },
    buildEnvVars(options.envVars)
  );

  return {
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
  intermediateImageUrl: string;
  publishDirectoryInImage: string;
  spaFallback: boolean;
}): string {
  const lines = [
    "FROM nginx:1.27-alpine",
    `COPY --from=${options.intermediateImageUrl} ${options.publishDirectoryInImage}/ /usr/share/nginx/html/`,
    "EXPOSE 80",
  ];

  if (options.spaFallback) {
    lines.splice(2, 0, "COPY nginx.conf /etc/nginx/conf.d/default.conf");
  }

  return `${lines.join("\n")}\n`;
}

async function buildStaticApplication(options: {
  tempRoot: string;
  buildRootDir: string;
  publishDirectory: string;
  spaFallback: boolean;
  envVars: Record<string, string>;
  buildkitAddress: string;
  deploymentId: string;
  localRegistryHost: string;
  localRegistryPort: number;
  imageUrl: string;
}): Promise<StrategyBuildResult> {
  const intermediateImageUrl = buildRegistryImageUrl({
    deploymentId: options.deploymentId,
    localRegistryHost: options.localRegistryHost,
    localRegistryPort: options.localRegistryPort,
    suffix: "static-build",
  });

  const railpackResult = await buildRailpackApplication({
    buildRootDir: options.buildRootDir,
    envVars: options.envVars,
    buildkitAddress: options.buildkitAddress,
    imageUrl: intermediateImageUrl,
  });

  const runtimeDir = path.join(options.tempRoot, "static-runtime");
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(
    path.join(runtimeDir, "Dockerfile"),
    buildStaticRuntimeDockerfile({
      intermediateImageUrl,
      publishDirectoryInImage: resolveContainerPublishDirectory(options.publishDirectory),
      spaFallback: options.spaFallback,
    }),
    "utf8"
  );

  if (options.spaFallback) {
    await writeFile(path.join(runtimeDir, "nginx.conf"), buildStaticNginxConfig(true), "utf8");
  }

  const imageSha = await runBuildctlBuild({
    buildkitAddress: options.buildkitAddress,
    contextDir: runtimeDir,
    dockerfileDir: runtimeDir,
    dockerfileName: "Dockerfile",
    imageUrl: options.imageUrl,
  });

  return {
    imageSha,
    detectedLanguage: railpackResult.detectedLanguage,
    detectedFramework: railpackResult.detectedFramework,
    languageVersion: railpackResult.languageVersion,
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
    const imageUrl = buildRegistryImageUrl(options);
    const buildRootDir = resolveBuildRootDirectory(
      repoDir,
      buildSettings.appBuildConfig.buildRoot
    );

    let result: StrategyBuildResult;

    switch (buildSettings.appBuildType) {
      case "dockerfile": {
        const config = buildSettings.appBuildConfig as AppDockerfileBuildConfig;
        result = await buildDockerfileApplication({
          buildRootDir,
          dockerfilePath: config.dockerfilePath,
          dockerContextPath: config.dockerContextPath,
          dockerBuildStage: config.dockerBuildStage ?? null,
          envVars: options.envVars,
          buildkitAddress: options.buildkitAddress,
          imageUrl,
        });
        break;
      }
      case "static": {
        const config = buildSettings.appBuildConfig as AppStaticBuildConfig;
        result = await buildStaticApplication({
          tempRoot,
          buildRootDir,
          publishDirectory: config.publishDirectory,
          spaFallback: config.spaFallback,
          envVars: options.envVars,
          buildkitAddress: options.buildkitAddress,
          deploymentId: options.deploymentId,
          localRegistryHost: options.localRegistryHost,
          localRegistryPort: options.localRegistryPort,
          imageUrl,
        });
        break;
      }
      case "railpack":
      default:
        result = await buildRailpackApplication({
          buildRootDir,
          envVars: options.envVars,
          buildkitAddress: options.buildkitAddress,
          imageUrl,
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
