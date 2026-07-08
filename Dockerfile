# Build stage: compile TypeScript
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY test ./test
RUN npm run build

# Runtime stage: production deps only
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

# DB, reports, and logs live here — mount persistent storage over /app/data
# (set DB_PATH=/app/data/appscout.db) to survive between job runs.
RUN mkdir -p /app/data /app/output /app/logs

ENTRYPOINT ["node", "dist/src/cli.js"]
CMD ["--help"]
