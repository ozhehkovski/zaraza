FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/opt/browsers
COPY package*.json ./
RUN apt-get update && apt-get install -y --no-install-recommends xvfb xauth && rm -rf /var/lib/apt/lists/* && npm ci --omit=dev && npx playwright install --with-deps chromium && chmod -R a+rX /opt/browsers
COPY --from=build /app/dist ./dist
COPY src/database/migration.sql ./dist/src/database/migration.sql
COPY tests/fixtures/live-products.json ./tests/fixtures/live-products.json
USER node
EXPOSE 8080
CMD ["xvfb-run","-a","node","dist/src/index.js"]
