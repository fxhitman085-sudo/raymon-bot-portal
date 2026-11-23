FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json libsignal-6.0.0.tgz ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY public-releases.json upgrade-v5.js community-v5-ui.js server.js store.js recovery.js vip.js pairing-diagnostics.js community.js worker.js bot-settings.js portal-v3.js index.html app.js portal-v3-ui.js vip-ui.js cc4.js vip-silver.svg vip-gold.svg vip-diamond.svg style.css bot-runtime.tar.gz bot-runtime-version.json vv.js ./
RUN npm run build && test -s bot-runtime/assets/announcements.jpg && node -e "require('./vv'); require('./store'); require('./worker')"
ENV NODE_ENV=production
CMD ["npm","start"]
