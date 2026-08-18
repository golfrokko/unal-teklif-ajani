FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PORT=4318 \
    HEADLESS=true

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npx playwright install --with-deps chromium \
    && npm cache clean --force

COPY public ./public
COPY src ./src

RUN mkdir -p /app/data/jobs /app/data/sessions \
    && chmod 700 /app/data /app/data/jobs /app/data/sessions

EXPOSE 4318

HEALTHCHECK --interval=30s --timeout=8s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4318/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/server.mjs"]
