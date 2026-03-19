# Nouva Agent Codebase

This repository is a Bun workspace with one runnable package and two publishable TypeScript
packages:

- `agent/`: the long-running process that talks to the Nouva API, inspects the host, and manages
  Docker containers
- `packages/agent-protocol/`: shared types and small helpers used by the agent at runtime and by
  external consumers of the wire contract
- `packages/service-images/`: the database image/runtime catalog the agent uses when provisioning
  PostgreSQL and Redis

The root `package.json` wires those workspaces together and exposes the top-level commands:

- `bun run check-types`
- `bun run test`
- `bun run build:agent-image`

Shared TypeScript settings live in `tsconfig.base.json`.

## Repository Layout

### `agent/`

`agent/package.json` defines the runtime entrypoints:

- `bun --watch src/index.ts` for local development
- `bun src/index.ts` for direct execution
- `bunx tsc` / `bunx tsc --noEmit` for build and typecheck

The package contains three source files:

- `agent/src/index.ts`: the main runtime loop
- `agent/src/docker-api.ts`: a minimal Docker Engine client over the Unix socket
- `agent/src/build.ts`: repository clone plus Railpack/BuildKit image build helper

### `packages/agent-protocol/`

`packages/agent-protocol/package.json` publishes `src/index.ts` directly. The package is
source-only; it does not build separate runtime artifacts before publishing.

Module breakdown:

- `src/types.ts`: enums and unions for work kinds and statuses, validation report types, runtime
  metadata, and agent capability flags
- `src/http.ts`: request and response DTOs for registration, heartbeat, work leasing, work
  completion/failure reporting, and metrics upload
- `src/agent.ts`: runtime config types, work payload types, metrics payload types, config defaults,
  and helper functions such as `getAgentRuntimeConfig()` and `canLeaseWorkItem()`
- `src/docker.ts`: Docker API version normalization and container stats parsing
- `src/metrics.ts`: `/proc` parsing for host CPU, memory, disk, and load averages
- `src/routing.ts`: Traefik file-provider YAML generation for a local HTTP route

`src/index.test.ts` covers contract fixture serialization, leaseability rules, route rendering,
Docker stats parsing, runtime-config env overrides, and host-metrics parsing.

### `packages/service-images/`

`packages/service-images/package.json` also publishes `src` directly.

Module breakdown:

- `src/credentials.ts`: the `ServiceCredentials` interface
- `src/images.ts`: `ServiceVariant`, `ImageConfig`, `PgBackrestIdentity`, the `SERVICE_IMAGES`
  registry, and helper lookups such as `getImageConfig()`, `getDefaultVersion()`, and
  `isVersionSupported()`
- `src/index.ts`: package export barrel

The current service catalog is small and hard-coded:

- PostgreSQL: default version `17`, supported `18/17/16/15`, data path `/var/lib/postgresql`
- Redis: default version `7.4`, supported `7.4/7.2/7.0`, data path `/data`

Environment-driven image selection happens at module load time in `src/images.ts`:

- `NOUVA_IMAGE_REGISTRY` prefixes default image names
- `NOUVA_POSTGRES_IMAGE` overrides the PostgreSQL image completely

`src/images.test.ts` covers defaults, pgBackRest identity generation, Redis args generation,
PostgreSQL env generation with backup context, and the env-based image override behavior.

## Agent Runtime Architecture

The runtime entrypoint is `agent/src/index.ts`. It is a single file that owns startup,
registration, heartbeat, metrics, work leasing, and work dispatch.

### Startup

On process start, the file reads environment variables into module-level constants:

- required:
  - `NOUVA_API_URL`
  - `NOUVA_SERVER_ID`
- optional:
  - `NOUVA_REGISTRATION_TOKEN`
  - `NOUVA_AGENT_VERSION`
  - `NOUVA_APP_DOMAIN`
  - `NOUVA_AGENT_DATA_VOLUME`
  - `NOUVA_AGENT_BUILDKIT_CONTAINER`
  - `NOUVA_AGENT_REGISTRY_CONTAINER`
  - `NOUVA_AGENT_TRAEFIK_CONTAINER`
  - `NOUVA_AGENT_BUILDKIT_ADDR`
  - `NOUVA_HOST_OS_ID`
  - `NOUVA_HOST_OS_VERSION_ID`

It then creates the local state directory `/var/lib/nouva-agent`, creates a `DockerApiClient`,
loads cached credentials from `/var/lib/nouva-agent/credentials.json`, and computes a default
runtime config via `getAgentRuntimeConfig()` from `@nouvacloud/agent-protocol`.

### Registration and Heartbeat

If no cached agent token exists, `registerAgent()`:

1. calls `collectValidationSnapshot()`
2. POSTs `/api/agent/register`
3. stores the returned agent token in `credentials.json`
4. uses the returned `config` as the next runtime config

After that, `sendHeartbeat()` POSTs `/api/agent/heartbeat` with the same validation snapshot shape.
If the API returns `401` and `NOUVA_REGISTRATION_TOKEN` is still available, the code retries by
calling `registerAgent()` once.

The heartbeat loop is driven by `setInterval()` in `main()`. The interval duration is taken from
the current `AgentRuntimeConfig`, and the latest config returned by heartbeat replaces the old one.

### Host Validation

`collectValidationSnapshot()` mixes local host inspection with Docker and API checks. It builds the
`ServerValidationReport` sent during registration and heartbeat.

Checks include:

- host OS and version from `NOUVA_HOST_OS_ID` and `NOUVA_HOST_OS_VERSION_ID`
- CPU architecture from `os.arch()`
- Docker availability through `docker.request("GET", "/version")`
- host ports `80` and `443` via `node:net`
- disk availability using `statfs("/hostfs")`
- API connectivity through `fetch(${API_URL}/health)`
- total memory through `os.totalmem()`
- BuildKit reachability by parsing `NOUVA_AGENT_BUILDKIT_ADDR`
- IP forwarding, cgroup v2, time sync, DNS stub configuration, and inotify limits by reading files
  under `/hostfs`
- public IP through `https://api.ipify.org?format=json`

The function returns both the raw host snapshot and
`capabilities: getDefaultAgentCapabilities()`.

### Base Runtime Containers

Before deploying an app, `ensureBaseRuntime()` provisions three helper containers through the
Docker API:

- a local registry named by `NOUVA_AGENT_REGISTRY_CONTAINER` with default `nouva-registry`
- a privileged BuildKit daemon named by `NOUVA_AGENT_BUILDKIT_CONTAINER` with default
  `nouva-buildkitd`
- a Traefik instance named by `NOUVA_AGENT_TRAEFIK_CONTAINER` with default `nouva-traefik`

It also creates the local Traefik network named in `AgentRuntimeConfig.localTraefikNetwork` and
ensures the dynamic config directory exists at `/var/lib/nouva-agent/traefik/dynamic`.

### App Build and Deploy Flow

The build and deploy path is split across `agent/src/build.ts` and `agent/src/index.ts`.

`handleBuildAndDeployApp()` calls `buildApp()` first.

`buildApp()` performs the following steps:

1. creates a temp directory under `os.tmpdir()`
2. clones the Git repository and checks out the requested commit
3. runs `railpack prepare` to write `railpack-plan.json` and `railpack-info.json`
4. parses `railpack-info.json` to infer language, framework, version, and internal port
5. runs `buildctl build` against `ghcr.io/railwayapp/railpack-frontend:latest`
6. pushes the image to the agent’s local registry as
   `localRegistryHost:localRegistryPort/nouva-app:<deploymentId>`

`deployAppImage()` then:

1. ensures the base runtime containers exist
2. creates a per-project Docker network using `hashProjectNetwork(projectId)`
3. removes the previous container from `runtimeMetadata` if one exists
4. creates a new app container with labels like `nouva.managed=true`, `nouva.server.id`,
   `nouva.project.id`, `nouva.service.id`, and `nouva.deployment.id`
5. connects the container to the project network and the local Traefik network
6. writes a Traefik YAML file named `<serviceId>.yml` under
   `/var/lib/nouva-agent/traefik/dynamic`

The return value includes:

- build metadata such as `buildDuration` and detected language/framework/version
- addressing info such as `internalHost`, `internalPort`, and `externalHost`
- `runtimeMetadata`
- `runtimeInstance`

`handleDeployOnlyApp()` skips the build phase and calls `deployAppImage()` directly with a provided
image URL.

### Database Provisioning

`handleDatabaseProvision()` uses `getImageConfig(payload.variant)` from
`@nouvacloud/service-images`.

For each request it:

1. creates the per-project Docker network
2. creates a Docker volume named `nouva-vol-<serviceId prefix>`
3. builds service env vars with `imageConfig.getEnvVars()`
4. optionally builds command-line args with `imageConfig.getArgs()`
5. creates the container, mounting the named volume at `imageConfig.dataPath`
6. optionally exposes the default service port if `publicAccessEnabled` is true

The function returns internal and external addressing plus `runtimeMetadata` and `runtimeInstance`.

### Routing, Restart, Remove, and Update

Other work handlers are small wrappers:

- `handleRestart()` restarts the container referenced by `runtimeMetadata`
- `handleRemove()` and `handleDeleteService()` remove the container and delete the local Traefik
  route file
- `handleSyncRouting()` rewrites the service route file using the current container name and
  `runtimeMetadata.internalPort` or the payload ingress port
- `handleUpdateAgent()` pulls a new image and starts a short-lived `docker:cli` container that
  stops and removes the current `nouva-agent` container and starts a new one with the inherited
  `NOUVA_` environment

### Work Polling and Dispatch

`main()` starts a work loop on `setInterval()` using the current
`AgentRuntimeConfig.pollIntervalSeconds`.

Each loop iteration:

1. POSTs `/api/agent/work/lease` with `serverId` and `limit: 5`
2. replaces the current runtime config with `leased.config`
3. processes each `workItem` sequentially through `processWorkItem()`

`processWorkItem()` switches on `workItem.kind` and dispatches to one of:

- `handleBuildAndDeployApp`
- `handleDeployOnlyApp`
- `handleRestart`
- `handleRemove`
- `handleDatabaseProvision`
- `handleDeleteService`
- `handleSyncRouting`
- `handleUpdateAgent`

The handler result is POSTed to `/api/agent/work/:id/complete`. If a handler throws, the error is
POSTed to `/api/agent/work/:id/fail`.

### Metrics Loop

`collectMetrics()` reads host metrics from `/hostfs/proc/stat`, `/hostfs/proc/meminfo`,
`/hostfs/proc/loadavg`, and `statfs("/hostfs")`, then parses them with
`parseHostMetricsSnapshot()` from `@nouvacloud/agent-protocol`.

It also calls `docker.listManagedContainers()`, filters to running containers with a
`nouva.service.id` label, and calls `docker.containerStats(container.Id)` for each. The stats are
converted into the `AgentMetricsEnvelope.services` array.

The metrics loop POSTs the combined envelope to `/api/agent/metrics`.

## Docker Client Layer

`agent/src/docker-api.ts` is the only place that talks to the Docker Engine directly.

Implementation details:

- transport: `node:http` over `socketPath: "/var/run/docker.sock"`
- API version discovery: raw `GET /version`, normalized by `negotiateDockerApiVersion()`
- container lifecycle helpers: `inspectContainer`, `createContainer`, `startContainer`,
  `stopContainer`, `removeContainer`, `restartContainer`
- image, network, and volume helpers: `pullImage`, `ensureNetwork`, `createVolume`
- orchestration helper: `ensureContainer`
- metrics helper: `containerStats`, which parses a single snapshot through
  `parseDockerStatsSnapshot()`

All higher-level runtime behavior in `agent/src/index.ts` is built on top of this client.

## Build And Publish Pipeline

### Local Build

`bun run build:agent-image` expands to:

```bash
docker build -f agent/Dockerfile -t nouva-agent:dev .
```

The Dockerfile builds from the workspace root. The builder stage installs dependencies and runs
`bun run check-types` in `agent/`. The runner stage installs the binaries the agent expects at
runtime:

- `git`
- `curl`
- `bash`
- `ca-certificates`
- `railpack` through `mise`
- `buildctl` downloaded from the BuildKit release tarball

The final container starts with:

```bash
bun src/index.ts
```

It does not run a compiled binary and it does not copy a `dist/` build output into the image.

### CI And Release

The repository-level CI workflow in `.github/workflows/ci.yml` runs:

1. `bun install --frozen-lockfile`
2. `bun run check-types`
3. `bun run test`
4. `docker build -f agent/Dockerfile -t nouva-agent:ci .`

The release workflow in `.github/workflows/release.yml` adds:

- GHCR login
- Docker image push with tags:
  - `ghcr.io/nouvacloud/nouva-agent:${GITHUB_REF_NAME}`
  - `ghcr.io/nouvacloud/nouva-agent:${GITHUB_SHA}`
  - `ghcr.io/nouvacloud/nouva-agent:latest`
- npm publication of:
  - `./packages/agent-protocol`
  - `./packages/service-images`

The image build injects `NOUVA_AGENT_VERSION` and OCI labels through Docker build args.

## Running, Testing, And Typechecking

From the repository root:

```bash
bun install
bun run check-types
bun run test
bun run build:agent-image
```

Package-local commands:

```bash
bun run --filter nouva-agent dev
bun run --filter nouva-agent start
bun run --filter @nouvacloud/agent-protocol check-types
bun run --filter @nouvacloud/service-images check-types
```

Current test coverage is limited to the two publishable packages. The root `bun run test` command
does not run tests for `agent/` because there are no `agent/src/*.test.ts` files yet.
