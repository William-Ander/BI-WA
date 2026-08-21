# BI WA Python/FastAPI - v3.2.31

Esta pasta contém a primeira camada funcional do backend Python/FastAPI do BI WA.

## O que já funciona

- `GET /api/health`
- `GET /api/version`
- `GET /api/public-config`
- `POST /api/auth/login`
- `GET /api/config`
- `GET /api/settings`
- `GET /api/reports`
- `POST /api/reports/{id}/run`
- `GET /api/sync/ping`
- `POST /api/sync/reports`
- `POST /api/mysql/test`

A camada Python lê os mesmos arquivos da versão atual:

- `data/reports.json`
- `data/settings.json`
- `data/semantic_model.json`

## Como testar

```bash
cd python_backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

Abra:

```text
http://127.0.0.1:8000/api/health
```

## Observação

O app principal continua usando Node.js/Express por segurança. A migração definitiva deve ser feita rota por rota, comparando as respostas do Node e do Python antes de trocar o frontend para apontar para o Python.
