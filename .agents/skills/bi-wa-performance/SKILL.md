---
name: bi-wa-performance
description: Diagnostica e otimiza desempenho do BI WA em consultas, cache PostgreSQL/memória/cliente, filtros, editor, realtime e sincronização. Use para lentidão, requests duplicados, timeout ou carga; não use para micro-otimizações sem evidência.
---

# BI WA — performance

Melhore latência e carga sem violar segurança, semântica ou consistência do runtime.

## Preparação

Leia [o mapa de performance](references/performance-map.md) antes de alterar cache, timeout, concorrência, realtime, sincronização ou query builder.

Comece por evidência:

- qual ação do usuário está lenta;
- quantas queries/requests são disparadas;
- tempo de build, banco, transferência e renderização;
- cache engine/hit/age e escopo de segurança;
- volume, filtros, página e visual envolvidos;
- estado de PostgreSQL, MySQL e scheduler.

## Método

1. Reproduza localmente com o menor cenário representativo.
2. Use métricas existentes: performance, Server-Timing, queryBuildCount e window.__BIWA_FIELD_PERF__.
3. Separe custo de compilação, banco, rede e DOM/gráfico.
4. Corrija a causa no nível certo: plano SQL, cache, deduplicação, paginação, cancelamento ou render progressivo.
5. Compare frio/quente e verifique integridade do resultado.

## Invariantes

- Uma mutação semântica de campo deve compilar no máximo uma consulta; mudanças puramente visuais podem não consultar.
- Não aplique resposta obsoleta; preserve AbortController, versão por visual e assinatura.
- Não remova cache de consulta ou force noCache: true para mascarar invalidação incorreta.
- Chaves de cache devem incluir contexto de segurança e filtros relevantes.
- Toda escrita autorizada deve invalidar os caches correspondentes.
- Não reintroduza leitura MySQL em relatórios/filtros para contornar cache PostgreSQL.
- Tabela/Matriz deve paginar/renderizar progressivamente e não bloquear linhas aguardando totais.
- Aba oculta, dashboard pausado ou subscription obsoleta não deve continuar gerando carga inútil.
- Aumentar timeout é último recurso e exige justificar o plano/volume observado.

## Validação

Execute npm run check e o validador mais próximo do fluxo. Runtime benchmarks exigem servidor/cache local e devem comparar resultado, não apenas tempo.

Na entrega, reporte antes/depois, cenário, cache frio/quente, contagem de queries e qualquer trade-off de memória ou atualidade.

