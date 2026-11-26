# --- build stage ---
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- dev stage: local hot reload, never deployed ---
# Selected with `target: dev` by docker-compose.watch.yml in the platform repo, which syncs src/
# and public/ into the container; tsx restarts the server on each change. Not the last stage, so
# a plain `docker build` still produces the runtime image below.
FROM build AS dev
COPY db ./db
COPY public ./public
CMD ["npx", "tsx", "watch", "src/index.ts"]

# --- runtime stage ---
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Build metadata baked in at deploy time (THI-68). The runtime image has no
# .git, so these args are the only commit source. Defaults to "unknown" when
# built without args (local builds) rather than guessing at runtime.
ARG GIT_COMMIT=unknown
ARG BUILD_TIME=unknown
# Declared this late on purpose: every RUN after an ARG rebuilds when its value
# changes, and BUILD_TIME changes on every deploy.
RUN printf '{"commit":"%s","buildTime":"%s"}\n' "$GIT_COMMIT" "$BUILD_TIME" > /app/dist/build-info.json
COPY db ./db
COPY public ./public
EXPOSE 3000
CMD ["node", "dist/index.js"]
