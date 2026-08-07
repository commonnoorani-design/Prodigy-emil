# Prodigy Educations Mail
#
# Runs anywhere containers run — Render, Fly.io, Railway, Coolify, or a plain
# VPS with Docker. Use this when your web host cannot run Node itself.
#
#   docker build -t prodigy-mail .
#   docker run -d --name prodigy-mail -p 3000:3000 \
#     -v prodigy-data:/app/data \
#     -e ADMIN_EMAIL=admin@prodigyeducations.com \
#     -e ADMIN_PASSWORD='choose-a-password' \
#     prodigy-mail
#
# Everything that must survive a redeploy lives in /app/data — the database,
# the uploaded profile pictures and the encryption key. Mount it as a volume
# or you will lose all three.

FROM node:20-bookworm-slim AS deps
WORKDIR /app
# No compiler or Python needed: every dependency is pure JavaScript or WASM.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-bookworm-slim
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data \
    UPLOAD_DIR=/app/data/uploads \
    DB_FILE=/app/data/prodigy-mail.db \
    TRUST_PROXY=true

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public
COPY scripts ./scripts

RUN mkdir -p /app/data/uploads && chown -R node:node /app
USER node

EXPOSE 3000
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
