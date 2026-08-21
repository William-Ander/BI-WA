# App Windows profissional - BI WA v3.2.31

Esta versão mantém o empacotamento Electron/Windows e adiciona opção de iniciar o app usando o backend Python/FastAPI.

## Modos disponíveis

- `npm run app`: abre o BI WA usando Node.js/Express.
- `BIWA_SERVER_ENGINE=python npm run app`: abre o BI WA usando Python/FastAPI experimental.
- `npm run build:win`: gera instalador Windows NSIS.
- `npm run pack:win`: gera versão portátil.

## Observações profissionais

O instalador inclui atalho na área de trabalho, menu iniciar, nome do produto BI WA e ícone oficial. Para distribuição final, ainda é recomendado assinar o instalador com certificado digital da empresa.


## v3.2.32 - Instalador unico

Os arquivos `.bat` auxiliares foram removidos. O pacote agora mantem somente `instalar_bi_wa.bat`; os demais fluxos devem usar o atalho criado pelo instalador ou comandos npm.
