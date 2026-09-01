FROM node:26-bookworm-slim AS build

WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY scripts/clean.mjs ./scripts/clean.mjs
COPY src ./src
RUN npm run build \
  && npm prune --omit=dev \
  && npm cache clean --force

FROM node:26-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /build/package.json /build/package-lock.json ./
COPY --from=build --chown=node:node /build/node_modules ./node_modules
COPY --from=build --chown=node:node /build/dist ./dist
COPY --chown=node:node README.md LICENSE ./

RUN mkdir -p /work && chown node:node /work

USER node
WORKDIR /work

ENTRYPOINT ["node", "/app/dist/bin.js"]
CMD ["--help"]
