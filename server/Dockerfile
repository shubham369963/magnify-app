FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare yarn@1.22.10 --activate
COPY package.json yarn.lock .npmrc ./
RUN yarn install --frozen-lockfile --non-interactive
COPY tsconfig.json ./
COPY src ./src
RUN yarn build && yarn install --production --frozen-lockfile --non-interactive

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/src/graphql/schema.graphql ./src/graphql/schema.graphql
RUN mkdir -p uploads && chown node:node uploads
USER node
EXPOSE 8000
CMD ["node", "dist/main.js"]