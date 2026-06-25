FROM node:22.21.1-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/release/package.json packages/release/package.json
COPY packages/functions/package.json packages/functions/package.json
COPY packages/runtime-kernel/package.json packages/runtime-kernel/package.json
COPY apps/core-gateway/package.json apps/core-gateway/package.json

RUN npm ci

COPY packages/release packages/release
COPY packages/runtime-kernel packages/runtime-kernel
COPY apps/core-gateway apps/core-gateway

RUN npm run build -w packages/release \
  && npm run build -w packages/runtime-kernel \
  && npm run build -w apps/core-gateway

FROM node:22.21.1-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4020
ENV CORE_GATEWAY_HOST=0.0.0.0

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/release/package.json ./packages/release/package.json
COPY --from=build /app/packages/release/dist ./packages/release/dist
COPY --from=build /app/packages/runtime-kernel/package.json ./packages/runtime-kernel/package.json
COPY --from=build /app/packages/runtime-kernel/dist ./packages/runtime-kernel/dist
COPY --from=build /app/apps/core-gateway/package.json ./apps/core-gateway/package.json
COPY --from=build /app/apps/core-gateway/dist ./apps/core-gateway/dist

EXPOSE 4020
CMD ["node", "apps/core-gateway/dist/server.js"]
