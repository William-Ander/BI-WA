const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const transforms = JSON.parse(fs.readFileSync(path.join(root, 'data', 'transform_queries.json'), 'utf8'));
const model = JSON.parse(fs.readFileSync(path.join(root, 'data', 'semantic_model.json'), 'utf8'));
const calculated = transforms.find((item) => item && item.name === 'Faturamento e Recebimento');

assert(calculated, 'Tabela Faturamento e Recebimento ausente.');
['Valor Frete', 'Chave NFe', 'Situação Recebimento', 'Frete Rateado Linha'].forEach((name) => {
  assert(calculated.daxExpression.includes('"' + name + '"'), 'Coluna ausente na tabela calculada: ' + name);
});
assert(calculated.daxExpression.includes('FRETERATEIO('), 'Rateio de frete por nota nao materializado.');
assert(server.includes('compileDaxFreightAllocationMeasure'), 'Compilacao da medida Frete Rateado ausente.');
assert(server.includes('ensurePgFreightAllocationSourceMeta'), 'Preparacao do rateio de frete ausente.');
assert(server.includes("'freight_totals_'"), 'Cache compacto dos totais de frete ausente.');
assert(!server.includes('ensurePgFreightAllocationMaterializedView'), 'A tabela calculada completa voltou a ser materializada.');
assert(server.includes("LEFT JOIN ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, sourceMeta.freightTotalsTable)"), 'Rateio nao usa o cache compacto por chave da nota.');
assert(server.includes('DESC NULLS LAST'), 'Ordenacao PostgreSQL de medidas nulas nao preservada.');
assert(server.includes("throw apiError('Nao foi possivel executar o visual:"), 'Erros de SQL do visual ainda podem ser ocultados.');

assert(server.includes('function splitTopLevelDaxAdditiveExpression'), 'Compilacao aditiva DAX com BLANK ausente.');
assert(/const additive = splitTopLevelDaxAdditiveExpression\(expr\);[\s\S]{0,700}COALESCE/.test(server), 'Soma DAX ainda pode propagar NULL em linhas sem frete.');

['Frete', 'Frete Rateado', 'Frete Rateado 2'].forEach((name) => {
  assert((model.measures || []).some((measure) => measure && measure.name === name && measure.table === 'Faturamento e Recebimento'), 'Medida ausente: ' + name);
});

console.log('OK: medidas de frete e tabela calculada validadas.');
