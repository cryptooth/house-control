# Node 22 brings fetch and WebSocket, so the server needs no packages at all.
FROM node:22-alpine

WORKDIR /app
COPY server.mjs ./
# The web UI, built by scripts/build-addon.sh (web/dist).
COPY www/ ./www/

ENV NODE_ENV=production
CMD ["node", "server.mjs"]
