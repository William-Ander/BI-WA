---
name: bi-wa-report-engine
description: Altera e diagnostica o motor de relatórios do BI WA, incluindo schema persistido, editor, páginas, visuais, Tabela/Matriz, totais, execução e renderização. Use para o pipeline de relatório; não use para DAX ou filtros isolados.
---

# BI WA — motor de relatórios

Preserve o contrato entre relatório salvo, normalização backend, editor, runtime e viewer online.

## Preparação

Leia [o mapa do motor de relatórios](references/report-engine-map.md) antes de mudar schema, visuais, páginas, execução, totais ou renderização.

Classifique a mudança em um ou mais fluxos:

- persistência/compatibilidade de relatório;
- edição e hidratação de relatório salvo;
- configuração de campos e geração de preview;
- execução do dashboard/Socket.IO;
- renderização de visual;
- paginação, totais e exportação.

## Método

Trace uma alteração ponta a ponta:

1. estado em data/reports.json;
2. normalizeReportVisuals, páginas, tema e segurança;
3. rotas /api/reports e /api/visual-query;
4. estado reportVisuals/reportPages no frontend;
5. buildVisualPreview e resposta de runtime;
6. renderReportPageVisuals/renderViz;
7. reabertura, viewer, exportação e realtime.

## Invariantes

- Preserve relatórios legados: normalizadores devem preencher defaults sem apagar campos necessários.
- Tabela/Matriz usa campos físicos como projeções diretas; agregue somente medidas/valores explicitamente semânticos.
- Múltiplos visuais têm identidade, página, posição, tamanho, estilo e campos independentes.
- Respostas assíncronas só podem aplicar dados se versão, visual e assinatura de configuração ainda coincidirem.
- A hidratação de relatório salvo não pode acionar autosave prematuro nem injetar filtros antigos no editor.
- A primeira página de Tabela/Matriz usa paginação server-side; totais autoritativos podem vir em consulta separada sem bloquear linhas.
- Não reimplemente totais fora de visualTotalsMetadataForRun().
- SQL salvo e gerado continua somente leitura e validado no backend.
- O viewer não recebe fórmula DAX/modelo completo nem ganha capacidade de edição.

## Validação

Execute npm run check, validadores estáticos de layout/persistência e, quando houver ambiente local, os validadores de runtime do pipeline. Para Tabela/Matriz, execute diretamente node scripts/validate-visual-rules.js, pois o alias npm citado em documentação não existe no pacote atual.

Relate o contrato persistido antes/depois, os tipos de visual cobertos e o comportamento em editor reaberto e viewer.

