# --- build stage ---
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- runtime stage ---
FROM node:22-alpine
WORKDIR /app
# Build metadata baked in at deploy time (THI-68). The runtime image has no
# .git, so these args are the only commit source. Defaults to "unknown" when
# built without args (local builds) rather than guessing at runtime.
ARG GIT_COMMIT=unknown
ARG BUILD_TIME=unknown
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Written after the COPY so earlier layers stay cacheable; the metadata layer
# itself always rebuilds when the args change.
RUN printf '{"commit":"%s","buildTime":"%s"}\n' "$GIT_COMMIT" "$BUILD_TIME" > /app/dist/build-info.json
COPY db ./db
COPY website ./website
EXPOSE 3000
CMD ["node", "dist/index.js"]
