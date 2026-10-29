# decker-chatty proxy. Secrets are never baked in: config.json is mounted at
# runtime (see docker-compose.yml), the session log lives on the /data volume.
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/chatty.db

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY *.mjs ./
COPY public ./public

# A named volume mounted here inherits this ownership, so the non-root node
# user can create and write the SQLite file (plus its -wal/-shm siblings).
RUN mkdir /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "server.mjs"]
