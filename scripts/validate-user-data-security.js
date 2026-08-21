const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
const semanticModel = JSON.parse(fs.readFileSync(path.join(root, 'data', 'semantic_model.json'), 'utf8'));

function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('Função não encontrada: ' + name);
  const headerEnd = source.indexOf('\n', start);
  const brace = source.lastIndexOf('{', headerEnd);
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = brace; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1] || '';
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') { blockComment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = '';
      }
      continue;
    }
    if (char === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (char === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error('Fim da função não encontrado: ' + name);
}

function requireText(text, pattern, message) {
  assert(pattern.test(text), message);
}

const runtimeSource = [
  extractFunction(server, 'normalizeOnlineUserDataFilters'),
  extractFunction(server, 'normalizeReportSecurity'),
  extractFunction(server, 'userMatchesRlsRule'),
  extractFunction(server, 'renderSecurityTemplate'),
  extractFunction(server, 'runtimeSecurityFiltersForReport'),
  extractFunction(server, 'normalizeOnlineFilters'),
  extractFunction(server, 'normalizeTableName'),
  extractFunction(server, 'normalizeTableKey'),
  extractFunction(server, 'sameTableName'),
  extractFunction(server, 'findRelationshipBetween'),
  extractFunction(server, 'relationshipAllowsFilterPropagation'),
  extractFunction(server, 'findFilterPropagationRelationship'),
  extractFunction(server, 'findFilterPropagationPath'),
  extractFunction(server, 'relationshipColumnForTarget'),
  extractFunction(server, 'findRelationshipPath'),
  extractFunction(server, 'resolveFilterCondition'),
  extractFunction(server, 'onlineFilterAppliesToTarget'),
  extractFunction(server, 'withDefaultOnlineFilterValues'),
  extractFunction(server, 'wrapResolvedFilterPredicate'),
  extractFunction(server, 'buildReportFilterWhere'),
  `
  globalThis.testApi = {
    normalizeOnlineUserDataFilters,
    runtimeSecurityFiltersForReport,
    normalizeOnlineFilters,
    buildReportFilterWhere,
    resolveFilterCondition
  };
  `
].join('\n\n');

const context = {
  crypto,
  APP_MODE: 'online',
  CALENDAR_TABLE_NAME: 'Calendario',
  defaultSemanticModel: () => semanticModel,
  defaultOnlineFilterValue: (filter) => String(filter && filter.defaultValue || ''),
  calendarContextDateRange: () => null,
  daxFilterContextRemoves: () => false,
  synchronizeCalendarFilterEntries: (entries) => entries,
  quoteIdent: (value) => '`' + String(value).replace(/`/g, '``') + '`',
  relationshipJoinCondition: (leftAlias, leftTable, leftColumn, rightAlias, rightTable, rightColumn) => leftAlias + '.`' + leftColumn + '` = ' + rightAlias + '.`' + rightColumn + '`',
  calendarFilterExpression: (field, column) => column,
  apiError: (message, status) => Object.assign(new Error(message), { status })
};
vm.createContext(context);
try {
  vm.runInContext(runtimeSource, context);
} catch (error) {
  const line = Number(String(error && error.stack || '').match(/evalmachine\.<anonymous>:(\d+)/)?.[1] || 1);
  console.error(runtimeSource.split(/\r?\n/).slice(Math.max(0, line - 6), line + 5).map((value, index) => String(Math.max(1, line - 5) + index).padStart(4, ' ') + ' | ' + value).join('\n'));
  throw error;
}

const api = context.testApi;
const pageRequiredFilter = api.normalizeOnlineFilters([{
  id: 'required-company-page',
  table: 'Empresas',
  field: 'Empresa',
  label: 'Empresa',
  type: 'number',
  ui: 'dropdown',
  allowAll: true,
  requiredPageIds: ['page_mc']
}]);
assert.throws(
  () => api.buildReportFilterWhere(pageRequiredFilter, {}, { targetTable: 'Faturamento', semanticModel, pageId: 'page_mc', activePageId: 'page_mc' }),
  (error) => error && error.status === 400 && /Empresa/.test(error.message),
  'A página obrigatória aceitou o filtro Empresa sem seleção.'
);
assert.doesNotThrow(
  () => api.buildReportFilterWhere(pageRequiredFilter, {}, { targetTable: 'Faturamento', semanticModel, pageId: 'page_livre', activePageId: 'page_livre' }),
  'A regra sem Todos vazou para uma página não marcada.'
);
const user = {
  role: 'viewer',
  username: 'empresa3',
  dataFilters: [{ table: 'Empresas', field: 'Empresa', value: '3', type: 'number' }]
};
const security = api.runtimeSecurityFiltersForReport({}, user);
assert.strictEqual(security.applied, 1, 'A restrição do usuário não entrou no runtime.');
assert.strictEqual(security.onlineFilters[0].mandatory, true, 'A restrição precisa ser obrigatória.');
assert.strictEqual(Object.values(security.filters)[0], '3', 'O valor fixo do servidor não foi preservado.');

const cleared = api.buildReportFilterWhere(
  security.onlineFilters,
  security.filters,
  { targetTable: 'Faturamento', semanticModel }
);
assert.deepStrictEqual(Array.from(cleared.params), ['3'], 'Limpar filtros removeu a restrição do usuário.');
assert(/src\.`Empresa`\s*=\s*\?/.test(cleared.whereSql), 'A restrição não alcançou a tabela fato relacionada.');

const mandatoryId = security.onlineFilters[0].id;
const tampered = api.buildReportFilterWhere(
  security.onlineFilters,
  { [mandatoryId]: '999', ...security.filters },
  { targetTable: 'Faturamento', semanticModel }
);
assert.deepStrictEqual(Array.from(tampered.params), ['3'], 'Um valor enviado pelo navegador substituiu a regra do servidor.');

assert.throws(
  () => api.buildReportFilterWhere(
    security.onlineFilters,
    security.filters,
    { targetTable: 'TabelaSemRelacao', semanticModel: { relationships: [] } }
  ),
  (error) => error && error.status === 403,
  'Tabela sem relacionamento não foi bloqueada em modo fail-closed.'
);
assert(
  api.resolveFilterCondition({ table: 'empresas', field: 'Empresa' }, 'Empresas', semanticModel),
  'Diferenca apenas entre maiusculas e minusculas ainda quebra filtro da mesma tabela.'
);

const duplicate = api.normalizeOnlineFilters([
  { id: 'optional', table: 'Empresas', field: 'Empresa', scope: 'global' },
  { id: 'mandatory', table: 'Empresas', field: 'Empresa', scope: 'global', mandatory: true }
]);
assert.strictEqual(duplicate.length, 1, 'Filtros equivalentes não foram normalizados.');
assert.strictEqual(duplicate[0].id, 'mandatory', 'O filtro opcional prevaleceu sobre a regra obrigatória.');
const crowdedFilters = Array.from({ length: 40 }, (_, index) => ({
  id: 'optional_' + index,
  table: 'Tabela' + index,
  field: 'Campo',
  scope: 'report'
})).concat(security.onlineFilters);
assert(
  api.normalizeOnlineFilters(crowdedFilters).some((filter) => filter.id === mandatoryId && filter.mandatory),
  'Uma lista cheia de filtros opcionais descartou a restrição obrigatória.'
);

requireText(server, /filters:\s*\{\s*\.\.\.\(filters[\s\S]{0,180}\.\.\.securityRuntime\.filters\s*\}/, 'O servidor não sobrescreve filtros do navegador com os valores obrigatórios.');
requireText(server, /const userContextEntries = req\.authRole === 'admin'[\s\S]{0,700}mandatory:\s*true/, 'As opções de filtro não recebem a restrição do usuário.');
requireText(server, /const cond = resolveFilterCondition[\s\S]{0,220}if \(!cond\) \{\s*return null;/, 'Opções de filtro não falham fechadas quando falta relacionamento.');
requireText(server, /domainContext\.securityCount\s*>\s*0[\s\S]{0,180}values:\s*\[\]/, 'A API de opções pode retornar dados sem aplicar uma restrição obrigatória.');
requireText(server, /const directUserRestrictions = userContextEntries\.filter[\s\S]{0,1300}cacheEngine:\s*'user-restriction'/, 'O próprio campo protegido não retorna diretamente apenas os valores permitidos.');
requireText(server, /dataRestrictionRevision:\s*onlineUserDataRestrictionRevision\(req\.authUser\)/, 'A configuração do usuário não identifica mudanças em sua restrição.');
requireText(server, /onlineUsers:\s*String\(role \|\| ''\)\.toLowerCase\(\) === 'admin'/, 'As restrições de outros usuários estão expostas a visualizadores.');
requireText(app, /user\.dataFilters = normalizeClientUserDataFilters\(workingDataFilters\)/, 'O modal de permissões não salva as restrições.');
requireText(app, /function filterOptionsClientCacheKey[\s\S]{0,500}clientDataSecurityScope\(\)/, 'O cache de opções de filtro não está separado por usuário/restrição.');
requireText(app, /function dashboardRuntimeStateStorageKey[\s\S]{0,180}clientDataSecurityScope\(\)/, 'Os filtros selecionados no portal não estão separados por usuário.');
requireText(app, /function dashboardCacheStorageKey[\s\S]{0,180}clientDataSecurityScope\(\)/, 'Os dados em cache do dashboard não estão separados por usuário.');
requireText(app, /const selectedValue = seen\.has\(requestedValue\) \? requestedValue : '';/, 'Um valor antigo não autorizado ainda pode reaparecer no seletor.');
requireText(app, /async function sanitizeRestrictedUserDashboardFilters[\s\S]{0,1400}dashboardFilterAliasKeys\(filter\)[\s\S]{0,200}delete current\[alias\]/, 'Um filtro salvo com valor não autorizado não é removido antes de executar o relatório.');
requireText(app, /ensureDashboardFilterDefaultsForReports\(state\.reports\);[\s\S]{0,300}await sanitizeRestrictedUserDashboardFilters/, 'O relatório pode executar antes de validar os filtros permitidos do usuário.');
assert(!/mandatory-access-filter/.test(app), 'O indicador visual de restrição ainda aparece no portal.');
requireText(index, /id="onlineUserDataFilterTable"[\s\S]{0,650}id="onlineUserDataFilterValue"/, 'O cadastro de usuário não possui os campos da restrição.');
requireText(styles, /\.user-data-security-editor\s*\{[\s\S]{0,900}\.user-data-filter-add-grid/, 'O editor de restrições não possui layout próprio.');

console.log('Restrições por usuário validadas: persistência, aplicação no servidor, proteção contra limpeza/tampering e fail-closed.');
