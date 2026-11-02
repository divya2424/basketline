# One image per service, for both folders (one pnpm workspace), from the repo root:
#   docker build --build-arg SERVICE=basketline/services/gateway .
# Node 24 runs the TypeScript sources directly (type stripping); no build step.
FROM node:24-alpine AS deps
WORKDIR /app
# pnpm, at the version package.json's packageManager pins.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY basketline/package.json basketline/
COPY basketline/packages/contracts/package.json basketline/packages/contracts/
COPY basketline/packages/platform/package.json basketline/packages/platform/
COPY basketline/services/gateway/package.json basketline/services/gateway/
COPY basketline/services/auth-service/package.json basketline/services/auth-service/
COPY basketline/services/ingestion-service/package.json basketline/services/ingestion-service/
COPY basketline/services/insights-service/package.json basketline/services/insights-service/
COPY retailer-sim/package.json retailer-sim/
COPY retailer-sim/packages/shared/package.json retailer-sim/packages/shared/
COPY retailer-sim/services/retailer-auth-service/package.json retailer-sim/services/retailer-auth-service/
COPY retailer-sim/services/product-service/package.json retailer-sim/services/product-service/
COPY retailer-sim/services/campaign-service/package.json retailer-sim/services/campaign-service/
# The web apps' manifests stay out: pnpm installs only the projects present.
# @divya2424/basketline-kafka (and the SDK, for the retailer) come from GitHub Packages,
# which needs a token even to read: a build secret (docker-compose.yml), so it never
# lands in the image.
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
COPY basketline/packages ./basketline/packages
COPY retailer-sim/packages ./retailer-sim/packages
COPY ${SERVICE} ./${SERVICE}
USER node
HEALTHCHECK --interval=5s --timeout=3s --retries=20 CMD wget -qO- http://127.0.0.1:${PORT}/health/ready || exit 1
CMD ["sh", "-c", "exec node ${SERVICE}/src/index.ts"]
