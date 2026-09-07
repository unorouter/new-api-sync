# The cluster metadata and sync cron: one compiled binary, frontend inlined, on
# distroless. config.yml is mounted from the sync-env secret at /app/config.yml and
# logs/ is a mounted volume, both resolved from the working directory.
FROM oven/bun:1.4 AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json config.example.yml ./
COPY src ./src
ARG TARGETARCH
RUN SYNC_TARGETS=bun-linux-$([ "$TARGETARCH" = arm64 ] && echo arm64 || echo x64) bun run src/build.ts && \
    mv dist/new-api-sync-linux-* /app/new-api-sync

FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f
WORKDIR /app
COPY --from=builder --chown=nonroot:nonroot /app/new-api-sync ./new-api-sync
ENTRYPOINT ["/app/new-api-sync"]
CMD ["metadata"]
