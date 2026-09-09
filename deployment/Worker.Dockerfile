# syntax=docker/dockerfile:1
ARG WORKER_IMAGE=openfn/ws-worker:v1.29.0@sha256:827f4897d120c322d977da7bc2810174332eb5ba4902fdb7279178812d787c18
ARG NODE_IMAGE=node:24.19.0-bookworm@sha256:4196d66a565c6f195728d9952f161f4adfe2ad753052a08b7ec7f1c5a6bda42b
FROM ${WORKER_IMAGE} AS upstream
FROM ${NODE_IMAGE} AS worker-runtime
# Upstream publishes Alpine only. Keep its compiled application unchanged and
# re-install the exact locked dependencies for glibc. Never rebuild its source.
COPY --from=upstream /app /app
WORKDIR /app
RUN corepack enable && CI=true pnpm install --frozen-lockfile --force --ignore-scripts
WORKDIR /app/packages/ws-worker
USER node
CMD ["node", "./dist/start.js"]

FROM ${NODE_IMAGE} AS adaptors
WORKDIR /opt/registry-adaptors
COPY package.json package-lock.json ./
COPY packages/registry-evidence/package.json packages/registry-evidence/package.json
COPY packages/registry-breg/package.json packages/registry-breg/package.json
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY deployment/check-native.cjs /opt/registry-adaptors/check-native.cjs
RUN node /opt/registry-adaptors/check-native.cjs
COPY packages/registry-evidence/src packages/registry-evidence/src
COPY packages/registry-evidence/configuration-schema.json packages/registry-evidence/configuration-schema.json
COPY packages/registry-breg/src packages/registry-breg/src
COPY packages/registry-breg/configuration-schema.json packages/registry-breg/configuration-schema.json
# Local loading expects packages/<adaptor>, including common and HTTP.
RUN ln -s ../node_modules/@openfn/language-common packages/common && \
    ln -s ../node_modules/@openfn/language-http packages/http

FROM worker-runtime AS worker
ARG PILOT_UID=1000
ARG PILOT_GID=1000
USER root
COPY --from=adaptors --chown=node:node /opt/registry-adaptors /opt/registry-adaptors
COPY deployment/check-worker.mjs /opt/registry-adaptors/check-worker.mjs
COPY deployment/check-engine.mjs /opt/registry-adaptors/check-engine.mjs
COPY pilot/lightning/project.mjs /opt/registry-adaptors/pilot-project.mjs
ENV OPENFN_ADAPTORS_REPO=/opt/registry-adaptors
ENV LOCAL_ADAPTORS=true
RUN node --experimental-vm-modules /opt/registry-adaptors/check-worker.mjs
# The upstream engine starts children with an empty environment. Their Node
# runtime needs a passwd entry for the mapped operator UID during startup.
RUN if ! getent group "$PILOT_GID" >/dev/null; then groupadd --gid "$PILOT_GID" pilot; fi && \
    if ! getent passwd "$PILOT_UID" >/dev/null; then \
      useradd --uid "$PILOT_UID" --gid "$PILOT_GID" --home-dir /var/cache/openfn --no-create-home --shell /usr/sbin/nologin pilot; \
    fi && \
    mkdir -p /var/cache/openfn && chown "$PILOT_UID:$PILOT_GID" /var/cache/openfn && chmod 0700 /var/cache/openfn
USER ${PILOT_UID}:${PILOT_GID}
