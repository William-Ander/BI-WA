const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const errors = [];

function requireText(text, pattern, message) {
  if (!pattern.test(text)) errors.push(message);
}

// REGRA CRITICA BI WA - Tabela/Matriz:
// 1) Campos em Eixo/Dimensao, Valores e selectedFields devem virar colunas diretas.
// 2) Tabela/Matriz nao podem gerar SUM(campo) automaticamente.
// 3) Ao adicionar/remover campo, o preview precisa atualizar no canvas.
requireText(server, /REGRA_CRITICA_TABELA_MATRIZ_COLUNAS_DIRETAS/, 'Faltou marcador da regra critica no backend.');
requireText(server, /\['table',\s*'matrix'\]\.includes\(visualization\)[\s\S]{0,500}\[dimension,\s*value\]/, 'Backend nao preserva dimension/value como campos diretos para table/matrix.');
requireText(server, /const canRawPreview = requestedFields\.length && \['table',\s*'matrix'\]\.includes\(visualization\)/, 'Backend nao ativa preview bruto para table/matrix com campos selecionados.');
requireText(server, /function shouldRunVisualAsRawTable[\s\S]{0,500}\['table',\s*'matrix'\]\.includes\(type\)/, 'Execucao de visual salvo nao esta protegida como tabela/matriz bruta.');

requireText(app, /REGRA_CRITICA_TABELA_MATRIZ_COLUNAS_DIRETAS/, 'Faltou marcador da regra critica no frontend.');
requireText(app, /function rawPreviewVisualType[\s\S]{0,200}\['table',\s*'matrix'\]\.includes/, 'Frontend nao reconhece table/matrix como preview bruto.');
requireText(app, /function visualBuilderReady[\s\S]{0,1200}selectedFields\.length && rawPreviewVisualType\(viz\)/, 'Editor nao libera renderizacao imediata de table/matrix com campos selecionados.');
requireText(app, /function buildVisualPreview[\s\S]{0,1100}fields:\s*visualFields/, 'Preview nao envia os campos coletados para o backend.');
requireText(app, /function scheduleVisualAutoUpdate[\s\S]{0,900}buildVisualPreview\(\{ silent: true, requestSequence \}\)/, 'Auto-update do canvas foi removido ou quebrado.');


// Protecao reforcada: filtros relacionados podem acrescentar WHERE, mas nao podem
// transformar Tabela/Matriz em agregacao. O bloco bruto do backend deve permanecer direto.
requireText(server, /if \(canRawPreview\) \{[\s\S]{0,800}const selectParts = \[\];[\s\S]{0,800}for \(const field of requestedFields\)[\s\S]{0,400}castColumnSqlExprForAlias\(field/, 'Backend perdeu SELECT direto de requestedFields para table/matrix.');
requireText(server, /if \(canRawPreview\) \{[\s\S]{0,50}const selectParts = \[\];[\s\S]{0,650}if \(whereParts\.length\) sql \+= ` WHERE \$\{whereParts\.join\(' AND '\)\}`;[\s\S]{0,200}LIMIT \$\{limit\}/, 'Backend deve aplicar filtros somente como WHERE no preview bruto de table/matrix.');
const backendRawBlock = (server.match(/if \(canRawPreview\) \{[\s\S]*?return \{ sql, params, storedSql: inlineSqlParams\(sql, params\), table \};\n  \}/) || [''])[0];
if (/SUM\(/.test(backendRawBlock)) {
  errors.push('Backend voltou a usar SUM() dentro do bloco bruto de Tabela/Matriz.');
}
// O frontend nao monta SQL bruto: apenas marca rawFields=true e envia os campos ao backend.
requireText(app, /if \(selectedFields\.length && rawPreviewVisualType\(viz\)\) return \{ ok: true, rawFields: true \};/, 'Frontend nao marca rawFields para table/matrix enviar campos diretos ao backend.');


// Fonte de dados do construtor: apenas caches, sem consulta MySQL direta no endpoint de preview.
requireText(server, /REGRA_CRITICA_FONTE_DADOS_CONSTRUTOR[\s\S]{0,800}NUNCA consultar MySQL diretamente neste endpoint/, 'Endpoint visual-query deve respeitar a regra: apenas caches, sem consulta MySQL direta.');
requireText(app, /pathText\.includes\('\/api\/visual-query'\) \? TABLE_ROWS_API_TIMEOUT_MS/, 'Frontend deve usar timeout maior/controlado para /api/visual-query, evitando abortar o editor em 15s.');


// REGRA nova - Visual de Rosca (donut) com segunda medida (secondaryValue):
// 1) Frontend deve expor um bucket "Valores 2" (select oculto #builderSecondaryValueSelect).
// 2) chartFields deve calcular secondaryNumericKey quando existir 2ª coluna numerica valida.
// 3) ECharts deve renderizar donut com 2 series concêntricas quando houver secondaryValue.
// 4) O painel Visual deve ter toggle de porcentagem e cor secundaria.
// 5) Backend deve agregar SUM(da 2ª medida) e propagar secondaryValue no payload e na query.
requireText(html, /id="builderSecondaryValueSelect"/, 'Frontend faltou o select oculto #builderSecondaryValueSelect para a 2ª medida do donut.');
requireText(html, /data-field-drop-target="secondaryValue"/, 'Frontend faltou o drop zone "Valores 2" para a 2ª medida do donut.');
requireText(html, /id="visualShowPercentToggle"/, 'Faltou o toggle "Mostrar porcentagem" no painel Visual.');
requireText(html, /id="visualSecondaryColor"/, 'Faltou o seletor de cor secundaria no painel Visual.');
requireText(app, /const secondaryNumericKey = \(keys\.includes\(requestedSecondaryValue\)/, 'chartFields nao calcula secondaryNumericKey para a 2ª medida do donut.');
requireText(app, /const hasSecondary = secondaryKey && secondaryValues && secondaryValues\.some/, 'renderEChart nao detecta a 2ª medida para o donut concêntrico.');
requireText(app, /kind === 'donut' && hasSecondary/, 'ECharts nao ativa o modo donut com 2 series concêntricas para a 2ª medida.');
requireText(app, /showPercent: style\.showPercent === true/, 'Estilo do visual nao expoe o toggle showPercent para o donut.');
requireText(app, /secondaryColor: style\.secondaryColor \|\| '#ef4444'/, 'Estilo do visual nao expoe a cor secundaria do donut.');
requireText(app, /secondaryValue: \$\('#builderSecondaryValueSelect'\) && \$\('#builderSecondaryValueSelect'\)\.value/, 'buildVisualPreview nao envia secondaryValue no payload para o backend.');
requireText(app, /secondaryValue: visual\.secondaryValue \|\| ''/, 'visualFilterRefreshPayload nao envia secondaryValue no payload de refresh de filtro.');
requireText(app, /visual\.secondaryValue = field;/, 'assignBuilderField nao atribui visual.secondaryValue ao soltar campo no bucket Valores 2.');
requireText(app, /function defaultReportVisual[\s\S]{0,400}secondaryValue: ''/, 'defaultReportVisual nao inicializa secondaryValue vazio.');
requireText(server, /const secondaryValue = String\(body\.secondaryValue \|\| ''\)\.trim\(\);/, 'Backend nao le secondaryValue do payload em buildVisualQueryFromRequest.');
requireText(server, /secondaryValue && secondaryValue !== value && \['donut', 'pie'\]\.includes\(visualization\)/, 'Backend nao ativa o caminho de query com 2 medidas para donut/pie com secondaryValue.');
requireText(server, /secondaryValue: visual\.secondaryValue \|\| ''/, 'Backend nao propaga secondaryValue ao construir query a partir do visual salvo.');
requireText(server, /if \(String\(visual\.visualization \|\| ''\)\.toLowerCase\(\) === 'donut'\) add\(visual\.secondaryValue\)/, 'Backend nao inclui secondaryValue nos campos diretos do donut.');


if (errors.length) {
  console.error('Validacao de regras visuais falhou:');
  for (const err of errors) console.error('- ' + err);
  process.exit(1);
}
console.log('Regras visuais validadas: tabela/matriz como colunas diretas + donut com 2ª medida (secondaryValue).');
