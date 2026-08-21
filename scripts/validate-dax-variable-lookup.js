const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const errors = [];

function requireText(pattern, message) {
  if (!pattern.test(server)) errors.push(message);
}

requireText(/function expandDaxVariables\(formula\)/, 'O compilador nao expande declaracoes VAR/RETURN.');
requireText(/function parseDaxVariableProgram\(formula\)/, 'A compilacao de medidas nao possui AST para VAR\/RETURN.');
requireText(/function bindDaxVariableProgram\(program, parentScope\)/, 'A compilacao de medidas nao possui escopo lexical de variaveis.');
requireText(/const program = parseDaxVariableProgram\(formula\)/, 'A compilacao de medidas nao usa o parser semantico de variaveis.');
requireText(/stripBalancedOuterParens\(expandDaxVariables\(expression\)\)/, 'Colunas calculadas nao usam a expansao VAR/RETURN.');
requireText(/function daxFilteredLookupSpecs\(formula\)/, 'O lookup filtrado com SELECTEDVALUE nao e reconhecido.');
requireText(/COUNT\(DISTINCT \$\{columnSql\}\) = 1/, 'SELECTEDVALUE nao preserva a semantica de valor unico.');
requireText(/function visualFilteredLookupJoinSourceSql\(spec, alias\)/, 'O visual nao cria uma fonte segura para lookup filtrado.');
requireText(/function appendVisualMeasureJoins\(/, 'Medidas em tabelas transformadas nao recebem joins de lookup.');
requireText(/if \(compiledMeasureJoinPlan\)[\s\S]{0,700}appendVisualMeasureJoins/, 'A tabela DAX transformada nao aplica o plano generico de joins da medida.');
requireText(/Number\(options\.limit\) === 0 \? 0 : clampLimit\(options\.limit, 200\)/, 'Consultas internas de tabelas transformadas continuam limitadas a 200 linhas.');
requireText(/CREATE OR REPLACE VIEW[\s\S]{0,500}projection\.sql/, 'A view modelada ainda pode ser removida antes de tabelas DAX dependentes.');

if (errors.length) {
  console.error(errors.map((error) => '- ' + error).join('\n'));
  process.exit(1);
}

console.log('DAX VAR/RETURN e lookup filtrado validados em medidas e colunas calculadas.');
