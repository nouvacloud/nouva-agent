import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const RAILPACK_BIN = process.env.RAILPACK_PATH || "railpack";
const BUILDCTL_BIN = process.env.BUILDCTL_PATH || "buildctl";

export interface BuildAppOptions {
  repoUrl: string;
  commitHash: string;
  deploymentId: string;
  envVars: Record<string, string>;
  localRegistryHost: string;
  localRegistryPort: number;
  buildkitAddress: string;
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

function buildEnvVars(envVars: Record<string, string>): Record<string, string> {
  return {
    ...process.env,
    NODE_ENV: "production",
    ...envVars,
  };
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

export async function buildApp(options: BuildAppOptions): Promise<BuildAppResult> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), `nouva-agent-${options.deploymentId}-`));
  const repoDir = path.join(tempRoot, "repo");
  const buildStart = Date.now();

  try {
    await cloneRepository(options.repoUrl, options.commitHash, repoDir);

    const childEnv = buildEnvVars(options.envVars);
    const infoFileName = "railpack-info.json";
    const planFileName = "railpack-plan.json";
    const infoFile = path.join(repoDir, infoFileName);

    const prepareArgs = ["prepare", "--plan-out", planFileName, "--info-out", infoFileName];
    for (const key of Object.keys(options.envVars)) {
      prepareArgs.push("--env", `${key}=\${${key}}`);
    }
    prepareArgs.push(repoDir);

    await execFile(RAILPACK_BIN, prepareArgs, {
      cwd: repoDir,
      env: childEnv,
    });

    const infoRaw = await readFile(infoFile, "utf8");
    const info = JSON.parse(infoRaw) as Record<string, unknown>;

    const imageTag = `nouva-app:${options.deploymentId}`;
    const imageUrl = `${options.localRegistryHost}:${options.localRegistryPort}/${imageTag}`;
    const buildctlArgs = [
      "--addr",
      options.buildkitAddress,
      "build",
      "--frontend",
      "gateway.v0",
      "--opt",
      "source=ghcr.io/railwayapp/railpack-frontend:latest",
      "--opt",
      `filename=${planFileName}`,
      "--local",
      `context=${repoDir}`,
      "--local",
      `dockerfile=${repoDir}`,
      "--output",
      `type=image,name=${imageUrl},push=true,registry.insecure=true,registry.http=true`,
      "--opt",
      "platform=linux/amd64",
    ];

    const { stdout, stderr } = await execFile(BUILDCTL_BIN, buildctlArgs, {
      cwd: repoDir,
      env: childEnv,
      maxBuffer: 1024 * 1024 * 32,
    });

    const metadata = inferBuildMetadata(info);
    return {
      imageUrl,
      imageSha: extractImageSha(`${stdout}\n${stderr}`),
      buildDuration: Date.now() - buildStart,
      ...metadata,
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export function hashProjectNetwork(projectId: string): string {
  return createHash("sha256").update(projectId).digest("hex").slice(0, 12);
}
