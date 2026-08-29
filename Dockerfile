# CLI-only image for the cluster metadata cron: bun runs src/ directly, no
# frontend build. config.yml is mounted from the sync-env secret at runtime.
FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
ENTRYPOINT ["bun", "run", "src/cli/index.ts"]
CMD ["metadata"]
