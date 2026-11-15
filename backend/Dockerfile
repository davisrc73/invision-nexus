FROM node:22-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build || mkdir -p dist

FROM node:22-alpine AS runner
# Instala ffmpeg (Format Guardrail) e android-tools (adb nativo para provisionamento e Watchdog Kiosk via Backoffice!)
RUN apk add --no-cache ffmpeg tzdata android-tools

WORKDIR /app
ENV NODE_ENV=production
# Guarda as chaves RSA do ADB no volume persistente do NAS para que a Box Android confie sempre no NAS
ENV HOME=/app/data/storage

COPY --from=builder /app/package*.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
COPY live-bridge.mjs ./live-bridge.mjs

RUN mkdir -p /app/data/storage/media /app/data/storage/thumbs

EXPOSE 3000
CMD ["node", "live-bridge.mjs"]

