# Nullspace

A verifiable end-to-end encrypted messaging system using X3DH key agreement and the Double Ratchet algorithm.
Application name: **Nullspace**. Third-year B.Tech mini project, CSE (AI & ML), Vignana Bharathi Institute of Technology.

Team: Battula Sitanshu (crypto / client core), Boini Vineeth Simha (backend), Ettaboina Maneesh Kumar (frontend / QA). Guide: Mrs. T. Adarana.

## What lives where

| Path | Purpose |
|---|---|
| `backend/` | Python 3.11+, FastAPI, SQLAlchemy (async), Alembic migrations, pytest |
| `frontend/` | React 18 + TypeScript + Vite; libsignal-client runs here in the browser |
| `docs/` | Protocol spec, decisions, workflow, evaluation results |
| `scripts/` | Operational scripts, e.g. the plaintext audit |
| `docker-compose.yml` | PostgreSQL 16 + backend for local development |

## Run it

Prerequisites: Docker Desktop, Node 20+, Python 3.11+.

```bash
cp .env.example .env
docker compose up --build          # PostgreSQL on 5432, backend on http://localhost:8000
```

In a second terminal:

```bash
cd frontend
npm install
npm run dev                        # http://localhost:5173
```

Open two browser profiles (or one normal + one incognito window) so each user gets its own IndexedDB key store.

Backend without Docker:

```bash
cd backend
python -m venv .venv && . .venv/Scripts/activate   # Windows; use .venv/bin/activate on Linux/macOS
pip install -r requirements.txt -r requirements-dev.txt
alembic upgrade head
uvicorn app.main:app --reload
```

## Tests

```bash
cd backend && pytest
cd frontend && npm run lint && npm run typecheck && npm test
```

## Workflow

See [docs/WORKFLOW.md](docs/WORKFLOW.md) and [docs/CONVENTIONS.md](docs/CONVENTIONS.md). Task IDs (P2.3 etc.) refer to the ClickUp list *Nullspace Build*.
