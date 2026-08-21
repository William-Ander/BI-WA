const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');

const baseUrl = process.env.BIWA_TEST_BASE_URL || 'http://127.0.0.1:3000';

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function request(path, options = {}, expectedStatus = 200) {
  const started = performance.now();
  const response = await fetch(baseUrl + path, options);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch (error) { body = { raw: text }; }
  assert.strictEqual(response.status, expectedStatus, path + ' HTTP ' + response.status + ': ' + (body.error || text.slice(0, 800)));
  return { body, elapsedMs: Number((performance.now() - started).toFixed(1)) };
}

function firstNumeric(body, name) {
  const row = Array.isArray(body && body.rows) ? body.rows[0] : null;
  const value = row && row[name];
  assert(Number.isFinite(Number(value)), 'A medida ' + name + ' não retornou valor numérico. Resposta: ' + JSON.stringify(row));
  return Number(value);
}

async function main() {
  const source = fs.readFileSync('server.js', 'utf8');
  assert(source.includes('function tokenizeDaxSemantic'), 'Tokenizer semântico DAX ausente.');
  assert(source.includes('function parseDaxVariableProgram'), 'AST de VAR/RETURN ausente.');
  assert(source.includes("type: 'VariableDeclaration'"), 'VariableDeclaration não existe na AST.');
  assert(source.includes("type: 'TableConstructor'"), 'TableConstructor não existe na AST.');
  assert(source.includes('function bindDaxVariableProgram'), 'Escopo lexical de VAR ausente.');
  assert(source.includes('function resolveDaxVariableBinding'), 'Resolver não prioriza variáveis locais.');
  assert(source.includes('function findTopLevelDaxInOperator'), 'IN semântico ausente.');
  assert(source.includes('function compileDaxTableConstructorSet'), 'TableConstructor não é compilado de forma set-based.');
  assert(source.includes('disconnectedDaxAggregateTables'), 'Medidas escalares de tabelas desconectadas não possuem plano próprio.');
  const compileStart = source.indexOf('function compileDaxExpression(formula');
  const compileEnd = source.indexOf('\nfunction tablesUsedInDaxExpression', compileStart);
  assert(compileStart > 0 && compileEnd > compileStart, 'Compilador DAX não encontrado.');
  assert(!source.slice(compileStart, compileEnd).includes('expandDaxVariables(formula)'), 'O compilador ainda usa substituição textual cega de VAR.');
  assert(!/measureName\s*===\s*["']Descontado/i.test(source), 'Foi criado hardcode para Descontado.');
  assert(!/variableName\s*===\s*["']GruposClientes/i.test(source), 'Foi criado hardcode para GruposClientes.');

  const protectedFiles = ['data/reports.json', 'data/semantic_model.json', 'data/transform_queries.json', 'data/settings.json'];
  const before = Object.fromEntries(protectedFiles.map((file) => [file, hash(file)]));
  const settings = JSON.parse(fs.readFileSync('data/settings.json', 'utf8'));
  const model = JSON.parse(fs.readFileSync('data/semantic_model.json', 'utf8'));
  const persistedMeasure = (model.measures || []).find((item) => item && item.name === 'Descontado');
  assert(persistedMeasure, 'A medida real Descontado não está salva no modelo.');
  assert(!/&#[a-z0-9]+;|\*\*|\\\*/i.test(String(persistedMeasure.formula || '')), 'A medida persistida contém HTML/Markdown indevido.');
  const login = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: settings.access.adminUser, password: settings.access.adminPassword, accessMode: 'admin' })
  });
  const headers = { authorization: 'Bearer ' + login.body.token, 'content-type': 'application/json' };

  const formulas = {
    'Teste VAR __ast': 'VAR X = 10 RETURN X',
    'Teste VAR 2 __ast': 'VAR X = 10 RETURN X * 2',
    'Teste Tabela __ast': 'COUNTROWS({"A", "B", "C"})',
    'Teste VAR Tabela __ast': 'VAR Lista = {"A", "B", "C"} RETURN COUNTROWS(Lista)',
    'Teste VAR VALUES __ast': "VAR Lista = VALUES('Cliente e Fornecedor'[Grupo Cliente]) RETURN COUNTROWS(Lista)",
    'Teste VAR Medida Escalar __ast': 'VAR X = [Valor Líquido vendas] RETURN X',
    'Teste IN __ast': `SUMX(
      VALUES('Cliente e Fornecedor'[Grupo Cliente]),
      IF('Cliente e Fornecedor'[Grupo Cliente] IN {"REDE G BARBOSA", "REDE MIX"}, 1, 0)
    )`,
    'Teste IN VAR __ast': `VAR Lista = {"REDE G BARBOSA", "REDE MIX"}
      RETURN SUMX(
        VALUES('Cliente e Fornecedor'[Grupo Cliente]),
        IF('Cliente e Fornecedor'[Grupo Cliente] IN Lista, 1, 0)
      )`,
    'Teste Medida __ast': `VAR Lista = {"REDE G BARBOSA"}
      RETURN SUMX(
        VALUES('Cliente e Fornecedor'[Grupo Cliente]),
        IF('Cliente e Fornecedor'[Grupo Cliente] IN Lista, [Valor Líquido vendas], 0)
      )`,
    'Teste Multiplicação __ast': `VAR Lista = {"REDE G BARBOSA"}
      RETURN SUMX(
        VALUES('Cliente e Fornecedor'[Grupo Cliente]),
        IF('Cliente e Fornecedor'[Grupo Cliente] IN Lista, [Valor Líquido vendas] * [Desconto Financeiro], 0)
      )`,
    'Descontado __ast': `VAR GruposClientes =
      {
        "REDE G BARBOSA",
        "REDE BOM PREÇO LOJAS",
        "REDE ATACADÃO/WMS",
        "REDE PERINI",
        "REDE MIX",
        "REDE HIPERIDEAL",
        "REDE ATAKAREJO / LOJAS",
        "REDE SAM'S CLUB",
        "ALMACEN",
        "REDE TOTAL ATACADO",
        "REDE CESTA DO POVO",
        "REDE MATEUS",
        "REDE MATEUS / LOJAS"
      }
      RETURN
      CALCULATE(
        SUMX(
          VALUES('Cliente e Fornecedor'[Grupo Cliente]),
          IF(
            'Cliente e Fornecedor'[Grupo Cliente] IN GruposClientes,
            [Valor Líquido vendas] * [Desconto Financeiro],
            0
          )
        )
      )`
  };
  const draft = JSON.parse(JSON.stringify(model));
  draft.measures = Array.isArray(draft.measures) ? draft.measures : [];
  for (const [name, formula] of Object.entries(formulas)) {
    draft.measures.push({ name, displayName: name, table: 'Faturamento e Recebimento', formula });
  }

  const validationResults = [];
  let finalSemanticPlan = null;
  for (const name of Object.keys(formulas)) {
    const validation = await request('/api/model/measures/validate', {
      method: 'POST', headers, body: JSON.stringify({ model: draft, measureName: name })
    });
    assert(validation.body.diagnostic && validation.body.diagnostic.valid, name + ' deveria ser válida: ' + JSON.stringify(validation.body));
    if (name === 'Descontado __ast') finalSemanticPlan = validation.body.diagnostic.semanticPlan;
    validationResults.push({ name, status: validation.body.diagnostic.status, elapsedMs: validation.elapsedMs });
  }
  assert(finalSemanticPlan && finalSemanticPlan.ast && finalSemanticPlan.ast.type === 'DaxProgram', 'Diagnóstico não expôs a AST DaxProgram.');
  assert(finalSemanticPlan.symbols.some((item) => item.name === 'GruposClientes' && item.type === 'table'), 'GruposClientes não foi registrada como variável tabular.');
  assert(finalSemanticPlan.variableReferences.includes('GruposClientes'), 'RETURN não preservou a referência lexical a GruposClientes.');
  for (const node of ['TableConstructor', 'VariableReference', 'IN', 'SUMX', 'VALUES', 'IF', 'CALCULATE', 'MeasureReference', 'Multiply']) {
    assert(finalSemanticPlan.nodes.includes(node), 'O plano semântico não registrou o nó ' + node + '.');
  }
  assert.strictEqual(finalSemanticPlan.logicalPlan.strategy, 'grouped-two-level-set-based', 'O planner não escolheu a estratégia set-based do SUMX(VALUES(...)).');

  async function visual(measureName, visualization = 'card', options = {}) {
    const dimensions = Array.isArray(options.dimensions) ? options.dimensions : [];
    const measureField = { name: measureName, table: 'Faturamento e Recebimento', type: 'measure' };
    return request('/api/visual-query', {
      method: 'POST', headers,
      body: JSON.stringify({
        table: 'Faturamento e Recebimento',
        visualId: '__dax_ast_' + visualization + '_' + crypto.createHash('sha1').update(measureName + JSON.stringify(options.filters || {})).digest('hex').slice(0, 8),
        visualization,
        dimension: dimensions[0] && dimensions[0].name || '',
        value: measureName,
        fields: [...dimensions, measureField],
        aggregation: 'SUM',
        order: 'DESC',
        page: 1,
        pageSize: Number(options.pageSize || 50),
        limit: Number(options.limit || 50),
        deferTotals: true,
        onlineFilters: options.onlineFilters || [],
        filters: options.filters || {},
        model: draft
      })
    });
  }

  const scalarExpected = [
    ['Teste VAR __ast', 10],
    ['Teste VAR 2 __ast', 20],
    ['Teste Tabela __ast', 3],
    ['Teste VAR Tabela __ast', 3]
  ];
  const scalarResults = [];
  for (const [name, expected] of scalarExpected) {
    const result = await visual(name);
    const actual = firstNumeric(result.body, name);
    assert.strictEqual(actual, expected, name + ' retornou ' + actual + ', esperado ' + expected + '.');
    scalarResults.push({ name, actual, elapsedMs: result.body.performance && result.body.performance.totalServerMs });
  }
  const valuesVariableResult = await visual('Teste VAR VALUES __ast');
  const valuesVariableCount = firstNumeric(valuesVariableResult.body, 'Teste VAR VALUES __ast');
  assert(valuesVariableCount > 0, 'VAR contendo VALUES não retornou uma tabela visível.');
  const scalarMeasureVariableResult = await visual('Teste VAR Medida Escalar __ast');
  const scalarMeasureVariableValue = firstNumeric(scalarMeasureVariableResult.body, 'Teste VAR Medida Escalar __ast');

  const directIn = await visual('Teste IN __ast');
  const variableIn = await visual('Teste IN VAR __ast');
  const directValue = firstNumeric(directIn.body, 'Teste IN __ast');
  const variableValue = firstNumeric(variableIn.body, 'Teste IN VAR __ast');
  assert.strictEqual(variableValue, directValue, 'IN direto e IN com variável produziram resultados diferentes.');

  const oneMeasure = await visual('Teste Medida __ast');
  const twoMeasures = await visual('Teste Multiplicação __ast');
  firstNumeric(oneMeasure.body, 'Teste Medida __ast');
  firstNumeric(twoMeasures.body, 'Teste Multiplicação __ast');

  const groupDimension = { name: 'Grupo Cliente', table: 'Cliente e Fornecedor', type: 'text' };
  const finalCard = await visual('Descontado __ast', 'card');
  const finalTable = await visual('Descontado __ast', 'table', { dimensions: [groupDimension], pageSize: 50, limit: 50 });
  const finalMatrix = await visual('Descontado __ast', 'matrix', { dimensions: [groupDimension], pageSize: 50, limit: 50 });
  const cardValue = firstNumeric(finalCard.body, 'Descontado __ast');
  assert(Array.isArray(finalTable.body.rows) && finalTable.body.rows.length > 0, 'Tabela com Descontado não retornou linhas.');
  assert(Array.isArray(finalMatrix.body.rows) && finalMatrix.body.rows.length > 0, 'Matriz com Descontado não retornou linhas.');
  assert(finalTable.body.rows.every((row) => Number.isFinite(Number(row['Descontado __ast']))), 'Tabela retornou valor inválido.');
  assert(finalMatrix.body.rows.every((row) => Number.isFinite(Number(row['Descontado __ast']))), 'Matriz retornou valor inválido.');

  const sql = String(finalCard.body.sql || '');
  assert(sql.includes("IN ('REDE G BARBOSA'"), 'O plano não compilou a variável tabular para IN set-based.');
  assert(sql.includes("'REDE SAM''S CLUB'"), 'Apóstrofo em SAM\'S CLUB não foi escapado corretamente.');
  assert(sql.includes('__biwa_values_rows'), 'SUMX(VALUES(...)) não gerou plano em dois níveis.');
  assert(!/CROSS\s+JOIN/i.test(sql), 'O plano introduziu CROSS JOIN indevido.');
  assert(!/(?:SUM|AVG|COUNT)\s*\(\s*(?:SUM|AVG|COUNT)\s*\(/i.test(sql), 'O plano contém agregação aninhada direta.');
  assert.strictEqual(finalCard.body.performance && finalCard.body.performance.queryBuildCount, 1, 'Card gerou mais de um plano de consulta.');

  const persistedCard = await request('/api/visual-query', {
    method: 'POST', headers,
    body: JSON.stringify({
      table: persistedMeasure.table,
      visualId: '__dax_ast_persisted_home_table',
      visualization: 'card',
      value: persistedMeasure.name,
      fields: [{ name: persistedMeasure.name, table: persistedMeasure.table, type: 'measure', measureId: persistedMeasure.name }],
      aggregation: 'SUM',
      limit: 1,
      model
    })
  });
  const persistedCardValue = firstNumeric(persistedCard.body, persistedMeasure.name);
  assert.strictEqual(persistedCard.body.performance && persistedCard.body.performance.queryBuildCount, 1, 'A medida persistida gerou mais de um plano.');
  assert(/FROM \(SELECT \* FROM `Faturamento e Recebimento` src\) src/i.test(String(persistedCard.body.sql || '')), 'A home table dimensional foi usada como fato de execução da medida.');

  const companyFilter = { id: '__company', table: 'Empresas', field: 'Fantasia', key: 'Empresas.Fantasia', label: 'Empresa', operator: '=', type: 'text', ui: 'dropdown', scope: 'report' };
  const yearFilter = { id: '__year', table: 'Calendario', field: 'Ano', key: 'Calendario.Ano', label: 'Ano', operator: '=', type: 'number', ui: 'search', scope: 'report' };
  const monthFilter = { id: '__months', table: 'Calendario', field: 'MesNome', key: 'Calendario.MesNome', label: 'Mês', operator: '=', type: 'text', ui: 'dropdown', multiSelect: true, scope: 'report' };
  const companies = await request('/api/filter-options?table=Empresas&field=Fantasia', { headers: { authorization: headers.authorization } });
  const companyValues = Array.isArray(companies.body.values) ? companies.body.values.slice(0, 2) : [];
  assert(companyValues.length >= 2, 'Não existem duas empresas para validar o contexto.');
  const filterResults = [];
  for (const company of companyValues) {
    const filtered = await visual('Descontado __ast', 'card', {
      onlineFilters: [companyFilter, yearFilter, monthFilter],
      filters: { [companyFilter.id]: company, [yearFilter.id]: '2026', [monthFilter.id]: 'Janeiro||Março||Agosto' }
    });
    filterResults.push({
      company,
      value: firstNumeric(filtered.body, 'Descontado __ast'),
      elapsedMs: filtered.body.performance && filtered.body.performance.totalServerMs,
      queryBuildCount: filtered.body.performance && filtered.body.performance.queryBuildCount,
      sql: String(filtered.body.sql || '')
    });
  }
  for (const result of filterResults) {
    assert.strictEqual(result.queryBuildCount, 1, 'Multiseleção gerou mais de uma consulta para ' + result.company + '.');
    assert(/IN\s*\(\s*'Janeiro'\s*,\s*'Março'\s*,\s*'Agosto'\s*\)/i.test(result.sql), 'Meses não foram enviados como um conjunto para ' + result.company + '.');
  }

  for (const file of protectedFiles) assert.strictEqual(hash(file), before[file], 'O teste alterou ' + file + '.');
  console.log(JSON.stringify({
    ok: true,
    validationResults,
    scalarResults,
    variableKinds: {
      valuesTableRows: valuesVariableCount,
      scalarMeasureValue: scalarMeasureVariableValue
    },
    inEquivalence: { direct: directValue, variable: variableValue },
    measureReferences: {
      oneMeasure: firstNumeric(oneMeasure.body, 'Teste Medida __ast'),
      multiplication: firstNumeric(twoMeasures.body, 'Teste Multiplicação __ast')
    },
    finalVisuals: {
      card: { value: cardValue, elapsedMs: finalCard.body.performance && finalCard.body.performance.totalServerMs, rows: finalCard.body.rows.length },
      table: { elapsedMs: finalTable.body.performance && finalTable.body.performance.totalServerMs, rows: finalTable.body.rows.length },
      matrix: { elapsedMs: finalMatrix.body.performance && finalMatrix.body.performance.totalServerMs, rows: finalMatrix.body.rows.length }
    },
    persistedMeasure: {
      homeTable: persistedMeasure.table,
      executionBase: 'Faturamento e Recebimento',
      cardValue: persistedCardValue,
      elapsedMs: persistedCard.body.performance && persistedCard.body.performance.totalServerMs,
      queryBuildCount: persistedCard.body.performance && persistedCard.body.performance.queryBuildCount
    },
    plan: {
      queryBuildCount: finalCard.body.performance && finalCard.body.performance.queryBuildCount,
      setBasedIn: true,
      twoLevelValuesIterator: true,
      crossJoin: false,
      nestedAggregate: false,
      sqlBytes: Buffer.byteLength(sql)
    },
    semanticPlan: finalSemanticPlan,
    filters: filterResults.map((item) => ({ company: item.company, value: item.value, elapsedMs: item.elapsedMs, queryBuildCount: item.queryBuildCount })),
    protectedFiles: 'inalterados'
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
