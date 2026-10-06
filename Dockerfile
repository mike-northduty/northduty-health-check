FROM mcr.microsoft.com/playwright:v1.58.2-jammy

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js worker.js api-monitor-worker.js ./
COPY lib ./lib

ENV NODE_ENV=production
USER pwuser

CMD ["node", "worker.js"]
