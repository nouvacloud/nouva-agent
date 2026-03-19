# Contributing

## Before Opening A Pull Request

- open an issue for significant changes so scope and compatibility are clear
- keep changes aligned with the single-Docker-host Nouva runtime model
- run `bun install`, `bun run check-types`, and `bun run test`

## Pull Request Expectations

- keep changes focused and behavior-preserving unless the PR explicitly changes behavior
- include tests for new public protocol helpers or service-image behavior where practical
- document any new environment variables, mounts, ports, or outbound network requirements

## Out Of Scope

- broadening the project into a generic agent framework
- changing the public wire contract without versioned release notes
