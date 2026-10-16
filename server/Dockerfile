FROM node:22-bookworm-slim AS backend-build
WORKDIR /app/server
RUN corepack enable && corepack prepare yarn@1.22.10 --activate
COPY server/package.json server/yarn.lock server/.npmrc ./
RUN yarn install --frozen-lockfile --non-interactive
COPY server/tsconfig.json ./tsconfig.json
COPY server/src ./src
RUN yarn build && yarn install --production --frozen-lockfile --non-interactive

FROM node:22-bookworm-slim AS frontend-build
WORKDIR /app/client
RUN corepack enable && corepack prepare yarn@1.22.10 --activate
COPY client/package.json client/yarn.lock ./
RUN yarn install --frozen-lockfile --non-interactive
COPY client/ ./
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_MAX_PDF_SIZE_BYTES=3145728
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY}
ENV NEXT_PUBLIC_MAX_PDF_SIZE_BYTES=${NEXT_PUBLIC_MAX_PDF_SIZE_BYTES}
ENV NEST_API_URL=http://127.0.0.1:8000
RUN yarn build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
ARG GRAFANA_VERSION=12.1.1
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl poppler-utils prometheus redis-server \
	&& curl -fsSL "https://dl.grafana.com/oss/release/grafana_${GRAFANA_VERSION}_amd64.deb" -o /tmp/grafana.deb \
	&& apt-get install -y --no-install-recommends /tmp/grafana.deb \
	&& rm -f /tmp/grafana.deb \
	&& rm -rf /var/lib/apt/lists/*
COPY --from=backend-build --chown=node:node /app/server/package.json /app/server/package.json
COPY --from=backend-build --chown=node:node /app/server/node_modules /app/server/node_modules
COPY --from=backend-build --chown=node:node /app/server/dist /app/server/dist
COPY --from=backend-build --chown=node:node /app/server/src/graphql/schema.graphql /app/src/graphql/schema.graphql
COPY --from=frontend-build --chown=node:node /app/client /app/client
COPY --chown=node:node server/scripts/start-all.mjs /app/server/scripts/start-all.mjs
COPY --chown=node:node server/monitoring /app/server/monitoring
RUN mkdir -p /app/uploads /tmp/grafana /tmp/prometheus /tmp/redis \
	&& chown -R node:node /app/uploads /tmp/grafana /tmp/prometheus /tmp/redis
USER node
EXPOSE 10000
CMD ["node", "server/scripts/start-all.mjs"]