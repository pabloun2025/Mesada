# syntax=docker/dockerfile:1
# --- 1. Compilar la PWA ---
FROM node:22-alpine AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# --- 2. Compilar la API ---
FROM node:22-alpine AS server
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npx tsc -p tsconfig.json && npm prune --omit=dev

# --- 3. Imagen final: solo lo necesario, usuario sin privilegios ---
FROM node:22-alpine
ENV NODE_ENV=production PORT=3000 STATIC_DIR=/app/public UPLOAD_DIR=/data/uploads
WORKDIR /app/server
COPY --from=server /app/server/node_modules ./node_modules
COPY --from=server /app/server/dist ./dist
COPY server/package.json ./
COPY server/migrations ./migrations
COPY --from=web /app/web/dist /app/public
RUN mkdir -p /data/uploads && chown -R node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "dist/index.js"]
