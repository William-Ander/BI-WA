# BI WA 3.2.41 - Melhorias aplicadas

## Segurança e pacote limpo
- Removidos do pacote final: `.env`, `data/settings.json`, `node_modules`, cache/perfil de navegador, logs e backups locais.
- Adicionado `data/settings.example.json` com valores fictícios para configuração segura.
- Atualizado `.env.example` para deixar claro que credenciais reais nunca devem ser enviadas no ZIP.
- Adicionado `npm run validate:package` para bloquear arquivos proibidos e segredos óbvios antes da entrega.
- Adicionado `npm run package:clean` para gerar um ZIP limpo automaticamente.

## Correções técnicas
- Corrigida duplicidade da função `downloadCsv` no frontend.
- Padronizada exportação CSV com BOM UTF-8, separador `;` e mensagem amigável quando não há dados.
- Corrigido bug na atualização em tempo real via WebSocket: a rotina agora usa o relatório acessível correto e respeita permissões online.
- Incrementada versão do app para `3.2.41`.

## Validação executada
- `npm run check`
- `npm run validate:package`

## Pontos que ainda dependem de material externo
A equivalência exata com o Power BI depende de pelo menos um destes itens:
- arquivo `.pbix` original;
- prints de todas as páginas;
- lista oficial de medidas DAX;
- lista de visuais/filtros esperados por tela;
- amostra de resultados esperados por período/empresa/produto.

Sem esses materiais, o app fica preparado e mais seguro, mas não é possível garantir que todos os números e visuais estão idênticos ao Power BI original.
