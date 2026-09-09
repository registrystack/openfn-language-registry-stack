# syntax=docker/dockerfile:1
FROM node:24.19.0-bookworm@sha256:4196d66a565c6f195728d9952f161f4adfe2ad753052a08b7ec7f1c5a6bda42b
WORKDIR /app
COPY services /app/services
RUN mkdir /data && chown node:node /data
USER node
CMD ["node", "services/event-bridge/src/server.js"]
