#!/bin/bash
# =====================================================
# BI WA - Configura PostgreSQL para aceitar conexões
# da instância Online (VPS) via rede.
# =====================================================
# Este script roda automaticamente na primeira
# inicialização do container PostgreSQL.
# Em reinicializações subsequentes, o pg_hba.conf
# já conterá a linha de acesso remoto.
# =====================================================

set -e

echo "[BI WA PG Config] Configurando pg_hba.conf para acesso remoto..."

PGCONF="$PGDATA/pg_hba.conf"

if [ -f "$PGCONF" ]; then
  # Verifica se a linha já existe (idempotente)
  if grep -q "0.0.0.0/0" "$PGCONF" 2>/dev/null; then
    echo "[BI WA PG Config] Acesso remoto já configurado em pg_hba.conf"
  else
    echo "host all all 0.0.0.0/0 scram-sha-256" >> "$PGCONF"
    echo "[BI WA PG Config] Linha de acesso remoto adicionada ao pg_hba.conf"
  fi
else
  echo "[BI WA PG Config] WARN: pg_hba.conf não encontrado em $PGCONF"
  echo "[BI WA PG Config] O container pode estar sendo inicializado pela primeira vez."
  echo "[BI WA PG Config] A configuração será aplicada na próxima reinicialização."
fi

echo "[BI WA PG Config] Configuração do PostgreSQL concluída."
