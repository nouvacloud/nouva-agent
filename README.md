# Nouva Agent Codebase

This repository contains a single runnable Bun package in `agent/`. It builds and publishes the
`ghcr.io/nouvacloud/nouva-agent` container image.

The agent process is implemented in three main runtime files plus two local helper modules:

- `agent/src/index.ts`: process entrypoint, API polling loop, host validation, metrics collection,
  and work dispatch
- `agent/src/docker-api.ts`: Docker Engine client over `/var/run/docker.sock`
- `agent/src/build.ts`: Git clone plus Railpack/BuildKit image build helper
- `agent/src/protocol.ts`: local wire-contract types and small parsing/rendering helpers used by
  the agent runtime
- `agent/src/service-runtime.ts`: local database runtime helpers used only by the agent executor,
  including the temporary legacy `provision_database` fallback

The root `package.json` is only workspace/build wiring for `agent/`. The shared TypeScript config
is in `tsconfig.base.json`.

## Repository Layout

### `agent/src/index.ts`

`index.ts` is the long-running control loop. It owns:

- environment variable loading
- persisted credentials under `/var/lib/nouva-agent/credentials.json`
- registration and heartbeat requests to the Nouva API
- server validation snapshot collection
- helper container provisioning for registry, BuildKit, and Traefik
- work leasing from `/api/agent/work/lease`
- per-work-item execution and completion/failure reporting
- host and container metrics collection

The file is intentionally monolithic. There is no app factory or separate service layer yet.

### `agent/src/docker-api.ts`

`DockerApiClient` is a thin wrapper around the Docker HTTP API. It uses `node:http` with
`socketPath: "/var/run/docker.sock"` and exposes the container/network/volume operations the agent
needs:

- image pull
- network and volume creation
- container inspect/create/start/stop/restart/remove
- container stats collection

`DockerApiClient.create()` probes `/version` first and normalizes the API version before all later
requests.

### `agent/src/build.ts`

`buildApp()` is the app-image builder used by `deploy_app` and `redeploy_app` work items.

It:

1. clones the source repository at the requested commit
2. runs `railpack prepare` to emit `railpack-plan.json` and `railpack-info.json`
3. parses `railpack-info.json` to infer language/framework/version/internal port metadata
4. runs `buildctl build` against `ghcr.io/railwayapp/railpack-frontend:latest`
5. pushes the built image to the agent’s local registry as
   `localRegistryHost:localRegistryPort/nouva-app:<deploymentId>`

The helper does not compile the app locally inside Node or Bun. It shells out to `git`, `railpack`,
and `buildctl`.

### `agent/src/protocol.ts`

`protocol.ts` is the local definition of the JSON wire contract the agent uses at runtime. It
contains:

- registration, heartbeat, lease, metrics, and work-mutation request/response interfaces
- work payload types such as `AppDeployPayload`, `DeployOnlyPayload`, and `UpdateAgentPayload`
- agent runtime config types and defaults
- work-lease helper logic
- Docker stats parsing
- host `/proc` metrics parsing
- Traefik local-route YAML generation

It exists inside this repo so the agent can compile without depending on a separately published
shared package.

### `agent/src/service-runtime.ts`

`service-runtime.ts` contains the database provisioning runtime helpers.

Its main job is `resolveDatabaseProvisionSpec(payload)`, which converts a `provision_database`
payload into the container inputs the executor needs:

- `image`
- `envVars`
- `containerArgs`
- `dataPath`
- `internalPort`

The resolver supports two payload shapes:

- the current executor-driven shape with `imageUrl`, `envVars`, `containerArgs`, and `dataPath`
- a temporary legacy fallback using `variant`, `version`, and `credentials`

The fallback exists only so the agent can roll forward safely while older control-plane payloads are
still in flight.

## Runtime Flow

### Startup

`index.ts` reads these environment variables at startup:

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
  - `NOUVA_IMAGE_REGISTRY`
  - `NOUVA_POSTGRES_IMAGE`

The process then creates `/var/lib/nouva-agent`, loads cached credentials, and computes the default
runtime config from `getAgentRuntimeConfig()`.

### Registration, Heartbeat, and Leasing

The agent registers with `/api/agent/register` when no cached token exists, then starts three loops:

- heartbeat loop posting `/api/agent/heartbeat`
- metrics loop posting `/api/agent/metrics`
- work loop posting `/api/agent/work/lease`

Leased work items are processed sequentially in `processWorkItem()`. Successful results are posted
to `/api/agent/work/:id/complete`; failures are posted to `/api/agent/work/:id/fail`.

### App Work Items

`deploy_app` and `redeploy_app` call `buildApp()` first, then `deployAppImage()`.

`rollback_app` skips the build and reuses an existing `imageUrl`.

`deployAppImage()`:

- ensures the helper runtime containers exist
- creates the per-project Docker network
- replaces any previous runtime container referenced in `runtimeMetadata`
- creates a new app container with Nouva labels
- connects it to the project network and the local Traefik network
- writes a Traefik file-provider route under `/var/lib/nouva-agent/traefik/dynamic`

### Database Work Items

`handleDatabaseProvision()` now resolves all database container inputs from the payload before it
talks to Docker.

For the executor-driven payload shape, the control plane has already decided:

- which image to run
- which env vars to inject
- which command args to use
- which data path to mount

For the legacy payload shape, `service-runtime.ts` derives those values locally as a compatibility
fallback.

### Update Work Item

`handleUpdateAgent()` pulls the target image and starts a short-lived `docker:cli` container that
stops/removes the current `nouva-agent` container and starts a replacement with the inherited
`NOUVA_*` environment.

## Build And Release Pipeline

### Local Image Build

The root build command is:

```bash
bun run build:agent-image
```

That expands to:

```bash
docker build -f agent/Dockerfile -t nouva-agent:dev .
```

`agent/Dockerfile` uses two stages:

- builder: installs Bun dependencies and runs `bun run check-types` in `agent/`
- runner: installs `git`, `curl`, `bash`, `ca-certificates`, `railpack`, and `buildctl`, then
  starts the agent with `bun src/index.ts`

The image runs directly from source. It does not copy a compiled binary into the final image.

### CI And Release

`.github/workflows/ci.yml` runs install, typecheck, tests, and a Docker build.

`.github/workflows/release.yml` runs the same verification steps and then publishes only the Docker
image tags:

- `ghcr.io/nouvacloud/nouva-agent:${GITHUB_REF_NAME}`
- `ghcr.io/nouvacloud/nouva-agent:${GITHUB_SHA}`
- `ghcr.io/nouvacloud/nouva-agent:latest`

The release workflow does not publish npm packages.

## Running And Testing

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
```

Current automated tests live in:

- `agent/src/protocol.test.ts`
- `agent/src/service-runtime.test.ts`
