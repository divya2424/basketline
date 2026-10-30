# One image per service: docker build --build-arg SERVICE=product-service .
# Node 24 runs the TypeScript sources directly (type stripping); no build step.
FROM node:24-alpine AS deps
WORKDIR /app
# pnpm, at the version package.json's packageManager pins.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/platform/package.json packages/platform/
COPY services/gateway/package.json services/gateway/
COPY services/auth-service/package.json services/auth-service/
COPY services/product-service/package.json services/product-service/
COPY services/campaign-service/package.json services/campaign-service/
COPY services/analytics-service/package.json services/analytics-service/
# @divya2424/basketline-kafka comes from GitHub Packages, which needs a token even
# to read: a build secret (docker-compose.yml), so it never lands in the image.
# pnpm takes registry credentials only from the user's config, so that names it.
RUN --mount=type=secret,id=npm_token,required=true \
    echo '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}' > /root/.npmrc && \
    NODE_AUTH_TOKEN="$(cat /run/secrets/npm_token)" pnpm install --frozen-lockfile --prod --ignore-scripts && \
    rm /root/.npmrc

FROM node:24-alpine
ARG SERVICE
ENV SERVICE=${SERVICE} NODE_ENV=production
WORKDIR /app
# The installed tree: node_modules at the root and in each workspace package (pnpm links them).
COPY --from=deps /app ./
COPY packages ./packages
COPY services/${SERVICE} ./services/${SERVICE}
USER node
HEALTHCHECK --interval=5s --timeout=3s --retries=20 CMD wget -qO- http://127.0.0.1:${PORT}/health/ready || exit 1
CMD ["sh", "-c", "exec node services/${SERVICE}/src/index.ts"]
