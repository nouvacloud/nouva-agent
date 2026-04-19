FROM oven/bun:1.3.5-debian AS builder

WORKDIR /app

COPY bun.lock package.json ./
COPY agent/package.json ./agent/
RUN bun install --frozen-lockfile

COPY agent ./agent

WORKDIR /app/agent
RUN bun run check-types

FROM oven/bun:1.3.5-debian AS runner

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    bash \
    ca-certificates \
    gzip \
    rclone \
    tar \
    && rm -rf /var/lib/apt/lists/*

ARG RAILPACK_VERSION=0.23.0
RUN curl -fL "https://github.com/railwayapp/railpack/releases/download/v${RAILPACK_VERSION}/railpack-v${RAILPACK_VERSION}-x86_64-unknown-linux-musl.tar.gz" -o /tmp/railpack.tar.gz && \
    tar -xzf /tmp/railpack.tar.gz -C /tmp && \
    mv /tmp/railpack /usr/local/bin/railpack && \
    chmod +x /usr/local/bin/railpack && \
    rm -rf /tmp/railpack.tar.gz /tmp/metadata.json /tmp/checksums.txt

ARG BUILDKIT_VERSION=v0.17.0
RUN curl -sSL "https://github.com/moby/buildkit/releases/download/${BUILDKIT_VERSION}/buildkit-${BUILDKIT_VERSION}.linux-amd64.tar.gz" -o /tmp/buildkit.tar.gz && \
    tar -xzf /tmp/buildkit.tar.gz -C /tmp && \
    mv /tmp/bin/buildctl /usr/local/bin/buildctl && \
    chmod +x /usr/local/bin/buildctl && \
    rm -rf /tmp/buildkit.tar.gz /tmp/bin

RUN railpack --version && buildctl --version

WORKDIR /app

COPY bun.lock package.json ./
COPY agent/package.json ./agent/
RUN bun install --frozen-lockfile --production

COPY agent ./agent

ARG VCS_REF=local
LABEL org.opencontainers.image.source="https://github.com/nouvacloud/nouva-agent"
LABEL org.opencontainers.image.revision="${VCS_REF}"
LABEL org.opencontainers.image.licenses="Apache-2.0"

ENV NODE_ENV=production

WORKDIR /app/agent
CMD ["bun", "src/index.ts"]
