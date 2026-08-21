# Plano de evolucao BI WA para padrao Power BI

## Objetivo

Transformar o BI WA em uma plataforma interna com duas versoes claras:

1. **BI WA Admin**: construcao de modelos, relatorios, dashboards, filtros e publicacao.
2. **BI WA Online**: visualizacao segura dos dashboards publicados pelos usuarios finais.

## Decisao tecnica recomendada

Manter a base atual em Node.js no curto prazo. Ela ja possui backend, designer, dashboards, atualizacao em tempo real, controle de permissoes e publicacao.

Python pode ser usado depois para servicos especificos, como processamento pesado, ETL, IA, analises com Pandas/Polars e APIs auxiliares. Uma reescrita completa agora atrasaria a entrega.

## Fase 1 - Base segura

- Remover credenciais reais do pacote.
- Remover `.env`, `node_modules`, logs e perfil local.
- Separar claramente `.env.example` e `.env.online.example`.
- Garantir que Online/Viewer seja somente leitura no backend.

## Fase 2 - Designer estilo Power BI

- Melhorar canvas central.
- Melhorar painel de campos.
- Melhorar painel de visualizacoes.
- Criar painel de formatacao com secoes recolhiveis.
- Adicionar grade, alinhamento, duplicar visual e copiar estilo.

## Fase 3 - Modelagem

- Criar relacoes visuais mais parecidas com Power BI.
- Adicionar medidas personalizadas.
- Melhorar tabela calendario.
- Suportar relacionamento ativo/inativo e propagacao de filtros.

## Fase 4 - Publicacao online

- Tela de publicacao com status.
- Controle por usuario/grupo.
- Historico de publicacoes.
- Link publico/privado por dashboard.

## Fase 5 - Opcional Python

Usar Python quando fizer sentido para:

- ETL com Pandas/Polars;
- cache analitico com DuckDB;
- consultas pesadas;
- previsoes/IA;
- exportacao automatica;
- APIs auxiliares com FastAPI.

## v3.2.25 - Etapa 3 concluída

O canvas central do Admin foi reforçado para trabalhar mais próximo do Power BI, com grade, régua visual, seleção mais clara, comandos de alinhamento, centralização, duplicação e controle de camada dos visuais.
