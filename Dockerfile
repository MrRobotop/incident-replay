FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS build
COPY package.json package-lock.json LICENSE ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json next.config.ts ./
COPY src ./src
COPY scenarios ./scenarios
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/package.json /app/next.config.ts /app/LICENSE ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/scenarios ./scenarios
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0", "--port", "3000"]
