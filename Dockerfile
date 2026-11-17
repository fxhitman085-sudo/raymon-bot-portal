FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json libsignal-6.0.0.tgz ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY server.js store.js worker.js bot-settings.js portal-v3.js index.html app.js portal-v3-ui.js style.css bot-runtime.tar.gz bot-runtime-version.json ./
RUN npm run build && test -s bot-runtime/assets/announcements.jpg
ENV NODE_ENV=production
CMD ["npm","start"]
