---
name: bi-wa-production-safety
description: Protege alterações do BI WA que envolvam autenticação, permissões, dados persistidos, sincronização, publicação, empacotamento ou deploy. Use antes de qualquer ação com impacto operacional; não substitui Skills de DAX, filtros ou layout.
---

# BI WA — segurança de produção

Preserve dados locais, limites de autorização e isolamento do Online/Viewer enquanto altera ou diagnostica o BI WA.

## Antes de agir

Leia [o mapa de segurança](references/safety-map.md) quando a tarefa tocar server.js, data/, permissões, login, sincronização, pacote, servidor online ou deploy.

Determine explicitamente:

- o modo afetado: Desktop/Admin, Online/Viewer ou ambos;
- se a ação é somente leitura, altera código, altera estado local ou afeta sistema externo;
- quais arquivos de usuário, bancos, endpoints ou hosts podem ser tocados;
- se iniciar o backend pode aplicar migrações por ensureStore().

## Regras de execução

- Não abra nem exponha .env, data/settings.json, credenciais, tokens, logs de autenticação ou configuração real.
- Não trate data/*.json como fixtures descartáveis. Leia apenas estrutura/metadados mínimos quando necessário.
- Não chame rotas de publicação/deploy, scripts SSH/Cloudflare, geradores de pacote ou sincronizações sem pedido explícito.
- Não use uma URL de produção como BIWA_TEST_BASE_URL.
- Para testes que iniciam server.js, use cópia isolada dos arquivos de estado quando houver risco de migração.
- Preserve apiAuthRequired, requireDesktopAdmin, requirePermission, requireSyncToken e o fail-closed do viewer.
- Preserve assertReadOnlySql() e a parametrização de filtros; não compense validação fraca confiando apenas no usuário de banco.
- Invalide caches após escrita autorizada usando os caminhos já existentes; não remova proteções de cache para “forçar atualização”.

## Atualização e entrega

instalar no servidor/ é um espelho de entrega. Atualizá-lo não é deploy. Só o sincronize quando a tarefa incluir explicitamente preparação do servidor/pacote, e nunca copie .env, settings.json, audit logs ou estado local para seeds.

Não altere versões ou marcadores automaticamente. Se a tarefa pedir release, reconcilie primeiro o drift entre package.json, package-lock.json, info/VERSION.json e info/marcadores/.

## Validação

Comece por npm run check. Para mudanças de segurança, use os validadores estáticos de viewer/admin/usuário listados no mapa. Execute npm run validate:package somente para auditar conteúdo; npm run package:clean cria/substitui ZIP e exige autorização específica.

Na entrega, informe o que foi alterado, quais estados externos não foram tocados e quais testes exigiriam ambiente isolado.

