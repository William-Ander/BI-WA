#!/usr/bin/env bash
set -euo pipefail

# ===============================================================
# BI WA — Deploy cloud automatizado
# Uso:  chmod +x scripts/deploy-cloud.sh
#       ./scripts/deploy-cloud.sh [--domain meuapp.com] [--email admin@meuapp.com]
# ===============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

# --- Cores ---
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

log()  { echo -e "${CYAN}[BI WA]${NC} $1"; }
ok()   { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

# --- Pré-requisitos ---
command -v docker >/dev/null 2>&1 || err "Docker não encontrado. Instale docker.io ou docker-ce."
command -v docker compose >/dev/null 2>&1 || err "Docker Compose v2 não encontrado."

# --- Args ---
DOMAIN=""
EMAIL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email)  EMAIL="$2"; shift 2 ;;
    --help)   echo "Uso: $0 [--domain meuapp.com] [--email admin@meuapp.com]"; exit 0 ;;
    *) err "Argumento desconhecido: $1. Use --help." ;;
  esac
done

# --- .env ---
if [ ! -f .env ]; then
  warn "Arquivo .env não encontrado. Criando a partir de .env.cloud.example..."
  if [ -f .env.cloud.example ]; then
    cp .env.cloud.example .env
    ok ".env criado. Edite as variáveis antes de continuar."
    echo -e "${YELLOW}Edite o arquivo .env com seus dados e execute novamente.${NC}"
    exit 0
  else
    cat > .env << 'ENVEOF'
# BI WA Cloud — configuração gerada pelo deploy script
APP_MODE=online
PORT=3000

# Credenciais administrativas
VIEWER_USER=viewer
VIEWER_PASSWORD=TroqueAqui
BIWA_AUTH_SECRET=
SYNC_TOKEN=

# MySQL (conforme docker-compose.cloud.yml)
MYSQL_HOST=mysql
MYSQL_PORT=3306
MYSQL_USER=biwa
MYSQL_PASSWORD=TroqueSenhaBiwa
MYSQL_DATABASE=biwa_cloud
MYSQL_SSL=false
DB_CONNECTION_LIMIT=10

# Refresh / tempo real
DEFAULT_REFRESH_SECONDS=15
SERVER_PUSH_INTERVAL_SECONDS=15
BIWA_QUERY_CACHE_ENABLED=true
BIWA_QUERY_CACHE_TTL_MS=15000

# Opcional: tabela de eventos no MySQL para invalidação de cache
# BIWA_REALTIME_EVENT_TABLE=minha_tabela
# BIWA_REALTIME_EVENT_COLUMN=updated_at

# Segurança
BIWA_ALLOW_OPEN_ONLINE=false
ENVEOF
    ok ".env criado com valores padrão. Edite antes de continuar."
    exit 0
  fi
fi

ok ".env encontrado."

# --- Valida .env ---
PASSWORD_COUNT=$(grep -c 'Troque' .env || true)
if [ "$PASSWORD_COUNT" -gt 0 ]; then
  warn "Ainda existem senhas 'Troque...' no .env. Edite o arquivo antes de publicar."
  sleep 2
fi

# --- Gera secrets se vazios ---
if grep -q '^BIWA_AUTH_SECRET=$' .env 2>/dev/null; then
  NEW_SECRET=$(openssl rand -hex 32)
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s/^BIWA_AUTH_SECRET=$/BIWA_AUTH_SECRET=$NEW_SECRET/" .env
  else
    sed -i "s/^BIWA_AUTH_SECRET=$/BIWA_AUTH_SECRET=$NEW_SECRET/" .env
  fi
  ok "BIWA_AUTH_SECRET gerado automaticamente."
fi

if grep -q '^SYNC_TOKEN=$' .env 2>/dev/null; then
  NEW_TOKEN=$(openssl rand -hex 32)
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s/^SYNC_TOKEN=$/SYNC_TOKEN=$NEW_TOKEN/" .env
  else
    sed -i "s/^SYNC_TOKEN=$/SYNC_TOKEN=$NEW_TOKEN/" .env
  fi
  ok "SYNC_TOKEN gerado automaticamente."
fi

# --- Certbot (SSL) ---
if [ -n "$DOMAIN" ] && [ -n "$EMAIL" ]; then
  log "Configurando SSL para $DOMAIN com e-mail $EMAIL..."

  # Inicia nginx sem SSL para o desafio ACME
  docker compose -f docker-compose.cloud.yml up -d nginx 2>/dev/null || true
  sleep 3

  # Gera certificado
  docker compose -f docker-compose.cloud.yml run --rm certbot certonly --webroot \
    -w /var/www/certbot \
    -d "$DOMAIN" \
    --email "$EMAIL" \
    --agree-tos \
    --non-interactive || warn "Certbot falhou. Verifique se $DOMAIN aponta para este servidor."

  # Substitui DOMAIN_NAME no nginx.conf
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s/\${DOMAIN_NAME}/$DOMAIN/g" nginx.conf
  else
    sed -i "s/\${DOMAIN_NAME}/$DOMAIN/g" nginx.conf
  fi
  ok "SSL configurado para $DOMAIN."
else
  warn "Pularndo SSL (use --domain e --email para ativar HTTPS automático)."
fi

# --- Build e deploy ---
log "Fazendo build da imagem Docker..."
docker compose -f docker-compose.cloud.yml build --pull app
ok "Build concluído."

log "Subindo serviços..."
docker compose -f docker-compose.cloud.yml up -d
ok "Serviços iniciados."

# --- Health check ---
log "Aguardando health check..."
for i in $(seq 1 12); do
  sleep 5
  STATUS=$(curl -sf http://localhost:3000/api/health 2>/dev/null || echo '{"ok":false}')
  if echo "$STATUS" | grep -q '"ok":true'; then
    ok "App está saudável!"
    break
  fi
  if [ "$i" -eq 12 ]; then
    warn "Health check não respondeu após 60s. Verifique os logs com: docker compose -f docker-compose.cloud.yml logs app"
  fi
done

echo ""
echo -e "${GREEN}══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  BI WA Cloud está no ar!${NC}"
echo -e "${GREEN}══════════════════════════════════════════════════${NC}"
echo ""
echo "  Local:    http://localhost:3000"
if [ -n "$DOMAIN" ]; then
  echo "  Domínio:  https://$DOMAIN"
fi
echo ""
echo "  Admin:    Configure o Desktop > Configuração > Publicar Online"
echo "            URL Online: https://$DOMAIN"
echo "            Sync Token: $(grep '^SYNC_TOKEN=' .env | cut -d= -f2-)"
echo ""
echo "  Logs:     docker compose -f docker-compose.cloud.yml logs -f app"
echo "  Parar:    docker compose -f docker-compose.cloud.yml down"
echo ""
