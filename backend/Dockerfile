# One image per service: docker build --build-arg SERVICE=product-service .
# Node 24 runs the TypeScript sources directly (type stripping); no build step.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/platform/package.json packages/platform/
COPY services/gateway/package.json services/gateway/
COPY services/auth-service/package.json services/auth-service/
COPY services/product-service/package.json services/product-service/
COPY services/campaign-service/package.json services/campaign-service/
COPY services/analytics-service/package.json services/analytics-service/
RUN npm ci --omit=dev --ignore-scripts

FROM node:24-alpine
ARG SERVICE
ENV SERVICE=${SERVICE} NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages ./packages
COPY services/${SERVICE} ./services/${SERVICE}
USER node
HEALTHCHECK --interval=5s --timeout=3s --retries=20 CMD wget -qO- http://127.0.0.1:${PORT}/health/ready || exit 1
CMD ["sh", "-c", "exec node services/${SERVICE}/src/index.ts"]
