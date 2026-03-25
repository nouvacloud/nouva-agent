import { buildApp, type BuildAppResult } from "./build.js";
import type { DockerApiClient } from "./docker-api.js";
import type {
	AgentRuntimeConfig,
	AppDeployPayload,
	RuntimeMetadata,
} from "./protocol.js";

export interface DeployAppImageInput {
	projectId: string;
	serviceId: string;
	deploymentId: string;
	serviceName: string;
	subdomain: string;
	envVars: Record<string, string>;
	imageUrl: string;
	resourceLimits: AppDeployPayload["resourceLimits"];
	runtimeMetadata?: RuntimeMetadata | null;
	detectedLanguage?: string | null;
	detectedFramework?: string | null;
	languageVersion?: string | null;
	internalPort?: number | null;
	buildDuration?: number | null;
}

export interface BuildAndDeployAppDependencies {
	ensureBaseRuntime: (
		docker: DockerApiClient,
		config: AgentRuntimeConfig,
	) => Promise<void>;
	buildApp: (options: {
		repoUrl: string;
		commitHash: string;
		deploymentId: string;
		envVars: Record<string, string>;
		localRegistryHost: string;
		localRegistryPort: number;
		buildkitAddress: string;
		appBuildType?: AppDeployPayload["appBuildType"];
		appBuildConfig?: AppDeployPayload["appBuildConfig"];
	}) => Promise<BuildAppResult>;
	deployAppImage: (
		docker: DockerApiClient,
		config: AgentRuntimeConfig,
		payload: DeployAppImageInput,
	) => Promise<Record<string, unknown>>;
}

export async function buildAndDeployAppWithDependencies(
	dependencies: BuildAndDeployAppDependencies,
	docker: DockerApiClient,
	config: AgentRuntimeConfig,
	payload: AppDeployPayload,
	buildkitAddress: string,
) {
	await dependencies.ensureBaseRuntime(docker, config);

	const buildResult = await dependencies.buildApp({
		repoUrl: payload.repoUrl,
		commitHash: payload.commitHash,
		deploymentId: payload.deploymentId,
		envVars: payload.envVars,
		localRegistryHost: config.localRegistryHost,
		localRegistryPort: config.localRegistryPort,
		buildkitAddress,
		appBuildType: payload.appBuildType ?? null,
		appBuildConfig: payload.appBuildConfig ?? null,
	});

	return await dependencies.deployAppImage(docker, config, {
		...payload,
		imageUrl: buildResult.imageUrl,
		buildDuration: buildResult.buildDuration,
		detectedLanguage: buildResult.detectedLanguage,
		detectedFramework: buildResult.detectedFramework,
		languageVersion: buildResult.languageVersion,
		internalPort: buildResult.internalPort,
	});
}

export const defaultBuildAndDeployAppDependencies = {
	buildApp,
};
