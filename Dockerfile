# syntax=docker/dockerfile:1
# BI WA — Dockerfile multi-estágio para produção

# ---- Estágio 1: dependências ----
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && \
    npm cache clean --force

# ---- Estágio 2: build (preparação) ----
FROM node:20-alpine AS build
WORKDIR /app
RUN apk add --no-cache tzdata ca-certificates
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# ---- Estágio 3: runtime (final, menor) ----
FROM node:20-alpine AS runtime

# Segurança: non-root user
RUN addgroup -S -g 1001 biwa && \
    adduser -S -u 1001 -G biwa biwa

# Timezone e certificados
RUN apk add --no-cache tzdata ca-certificates curl

WORKDIR /app

# Copia apenas o necessário do estágio build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server.js .
COPY --from=build /app/package.json .
COPY --from=build /app/data ./data
COPY --from=build /app/public ./public
COPY --from=build /app/info ./info
COPY --from=build /app/scripts ./scripts

# Cria diretório de dados com permissões corretas
RUN mkdir -p /app/data && chown -R biwa:biwa /app/data

# Porta
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

# Usuário não-root
USER biwa:biwa

CMD ["node", "server.js"]
