FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json libsignal-6.0.0.tgz ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY server.js store.js worker.js index.html app.js style.css bot-runtime.tar.gz ./
RUN npm run build
ENV NODE_ENV=production
CMD ["npm","start"]
