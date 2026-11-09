# Nullspace Team Guide: Vineeth and Maneesh

This is the one document you need. It covers the one-time setup, the loop you follow for every task, how to use Gemini so it helps instead of misleading you, and what to do before and after each task.

Roles:

| Person | Role | Owns |
|---|---|---|
| Vineeth | Backend (Member A) | FastAPI, PostgreSQL, Alembic, WebSocket manager, offline queue, media relay |
| Maneesh | Frontend and QA (Member C) | React UI, verification and history screens, Playwright tests, deck, demo video |
| Sitanshu | Crypto and client core (Member B) | libsignal integration, key store, sessions, export, report |

Task board: ClickUp list **Nullspace Build**. Repository: `https://github.com/krishbattula4/nullspace-vbit`.

---

## Part 1. One-time setup (about 45 minutes)

### 1.1 Install these

| Tool | Version | Where | Check it works |
|---|---|---|---|
| Git | latest | git-scm.com | `git --version` |
| Node.js | 20 LTS | nodejs.org | `node --version` prints v20.x |
| Python | 3.12 | python.org, tick **Add to PATH** | `python --version` |
| Docker Desktop | latest | docker.com | `docker --version`, and the whale icon is running |
| VS Code | latest | code.visualstudio.com | opens |

VS Code extensions: Python, Pylance, ESLint, Prettier, Docker.

Docker Desktop on Windows needs WSL 2. If it asks, let it enable it and restart.

### 1.2 Git identity, once

```bash
git config --global user.name "Your Name"
git config --global user.email "24p61a66xx@vbithyd.ac.in"
```

Use the same email as your GitHub account.

### 1.3 Clone to a short path

Windows breaks on long paths. Keep the project at `C:\dev\nullspace-vbit`.

```bash
mkdir C:\dev
cd C:\dev
git clone https://github.com/krishbattula4/nullspace-vbit.git
cd nullspace-vbit
copy .env.example .env
```

The first clone opens a browser window to sign in to GitHub. Sign in once; Git remembers it.

### 1.4 Run the backend and database

```bash
docker compose up --build
```

First run takes a few minutes. When it settles, open `http://localhost:8000/health` in a browser. You should see:

```json
{"status":"ok","db":"ok"}
```

Leave this terminal running. Press `Ctrl+C` to stop it later.

### 1.5 Run the frontend

Open a second terminal:

```bash
cd C:\dev\nullspace-vbit\frontend
npm install
npm run dev
```

Open `http://localhost:5173`. The header shows **backend: ok** when both are up.

### 1.6 Backend tests without Docker (Vineeth)

```bash
cd C:\dev\nullspace-vbit\backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt -r requirements-dev.txt
pytest
```

Tests use SQLite by default, so they run even when Docker is off.

### 1.7 Confirm you are set

- [ ] `/health` shows `db: ok`
- [ ] Frontend loads and header says backend: ok
- [ ] `pytest` passes (Vineeth) or `npm test` passes (Maneesh)
- [ ] You can see the ClickUp list and your tasks are assigned to you

If any box is unticked, fix it before starting a task. Ask in the group with the exact error text.

---

## Part 2. The loop for every task

Do this in order, every time. Do not skip steps even for small tasks.

### Before you start

1. **Open the ClickUp task.** Read the description and the acceptance criteria twice.
2. **Check it is not blocked.** The task shows "Waiting on" if something must finish first. If it is blocked, pick the next unblocked task in your list.
3. **Move it to In Progress** in ClickUp.
4. **Update your local main and branch:**

```bash
cd C:\dev\nullspace-vbit
git checkout main
git pull
git checkout -b P2.3-message-router
```

Branch name = task ID + two or three words. Examples: `P1.1-users-table`, `P1.6-auth-screens`.

5. **Re-read the acceptance criteria** and write them as a checklist in a scratch note. That is your definition of finished.

### While you work

- Commit small and often, with the task ID first:

```bash
git add .
git commit -m "P2.3: persist message and version 1"
```

- Run tests before every commit. Backend: `pytest`. Frontend: `npm run lint && npm run typecheck && npm test`.
- Stuck for more than 30 minutes? Post in the group: what you tried, the exact error, the file. Do not sit on it.
- Never commit `.env`, keys, tokens or `node_modules`. If you add a new setting, add it to `.env.example` with a placeholder value.

### After you finish

1. **Tick every acceptance criterion yourself.** If one is not met, you are not finished.
2. **Run the full checks one last time** on a clean state:

```bash
git status            # nothing unexpected
pytest                # backend
npm run lint && npm run typecheck && npm test && npm run build   # frontend
```

3. **Push and open the pull request:**

```bash
git push -u origin P2.3-message-router
```

Open the link Git prints. The PR template appears. Fill every section: ClickUp link, what changed, acceptance criteria ticked, evidence (screenshot or 20-second recording).

4. **Wait for CI.** The Actions tab turns green or red in a few minutes. Red means fix it before asking for review. Open the failed job and read the last 30 lines.
5. **Request review** by posting the PR link in the group. Sitanshu reviews and merges.
6. **Respond to review comments** with new commits on the same branch. Do not open a new PR.
7. **Reviewer squash-merges** when green and approved. Author deletes the branch.
8. **In ClickUp:** move the task to Complete and paste the PR link as a comment. Dependent tasks unblock automatically.
9. **Back to main:**

```bash
git checkout main
git pull
```

### Review assignment

Sitanshu reviews and merges all pull requests, including his own after an independent check. Vineeth and Maneesh request review by posting the PR link in the group; expect a response within 24 hours. Branch protection on main requires a pull request and green CI for everyone.

### When you are the reviewer (15 to 20 minutes)

1. **Read the PR page.** Description, ticked criteria, evidence. If CI is red, send it back immediately.
2. **Run it locally.**
   ```bash
   git fetch origin
   git checkout <branch>
   docker compose up --build            # if backend changed
   cd frontend && npm install && npm run dev   # if frontend changed
   ```
   Do by hand what each acceptance criterion describes. Approving from reading alone is not a review.
3. **Read the code against the rules.** For each file: could plaintext or a private key reach the server or logs? Does every new endpoint or event check the JWT and sender ownership? Is each criterion covered by a test that could fail? Is anything outside the task's scope?
4. **Ask Gemini for a second opinion.** `git diff main...origin/<branch> > pr.diff`, then paste the diff after the context block with the review prompt in Part 3.3. Verify every finding yourself before posting it; it produces false positives.
5. **Write the review on GitHub.** One line comment per problem, specific and polite. Then Review changes: Approve if all criteria are met and no rule is broken; Request changes otherwise. After approving: Squash and merge, Delete branch, post in the group.

A reviewer never fixes the code themselves, never approves without running it, and never approves because the author is busy.

---

## Part 3. Using Gemini well

Gemini is useful for drafting code, explaining errors and writing tests. It is also confidently wrong about this exact kind of project, because it will suggest the easy insecure path. You stay responsible for what you commit.

### 3.1 The context block

Paste this at the top of every new Gemini conversation, before anything else. Keep it in a file called `GEMINI_CONTEXT.txt` on your desktop.

```
PROJECT CONTEXT (read fully before answering)

I am building "Nullspace", a one-to-one end-to-end encrypted chat app for a college project.
Stack: Python 3.12 + FastAPI + async SQLAlchemy 2 + Alembic + PostgreSQL 16 on the backend;
React 18 + TypeScript + Vite on the frontend; WebSockets for real-time; JWT auth;
encryption via the Signal Protocol using @signalapp/libsignal-client in the browser.

Non-negotiable rules:
1. The server stores and relays CIPHERTEXT ONLY. No endpoint, model, log or test may put
   plaintext message content on the server. Ciphertext columns are BYTEA.
2. Private keys never leave the browser (IndexedDB). The server holds public prekeys only.
3. Every REST call after login and every WebSocket connection carries a JWT.
4. Only the message sender may edit, delete or retract it. Enforce on the server.
5. Edits never overwrite: each edit/delete/retract inserts a new row in message_versions.
6. Do not invent libraries or APIs. If unsure whether a function exists, say so.
7. Prefer small, typed, tested code. Python: type hints, ruff clean. TS: strict mode, no any.
8. Follow the existing project structure I paste. Do not restructure.

When you answer: give the code, then a short list of what to test, then any risk you see.
```

### 3.2 The task prompt format

After the context block, use this for each task:

```
TASK: <paste the ClickUp task name>

DESCRIPTION:
<paste the ClickUp description>

ACCEPTANCE CRITERIA:
<paste them>

EXISTING CODE (relevant files, pasted exactly):
--- backend/app/core/db.py ---
<paste>
--- backend/app/main.py ---
<paste>

WHAT I NEED:
1. Implementation that satisfies every acceptance criterion.
2. A pytest (or vitest) test for each criterion.
3. Tell me which files to create or change, with full paths.
4. Tell me what could go wrong and how I verify it manually.
```

Rules for this step:

- Paste real files, not descriptions of them. Gemini guesses badly from descriptions.
- Never paste `.env`, tokens, passwords or anything from `.env` into any AI tool.
- Ask for one task at a time. A prompt covering three tasks produces code for none of them properly.

### 3.3 Prompts for other situations

**When something errors:**

```
I ran: <exact command>
I got this error (full text):
<paste the whole traceback or console output>
Relevant file:
<paste>
Explain the cause in two sentences, then the minimal fix. Do not rewrite unrelated code.
```

**Before you open a PR, ask Gemini to review you:**

```
Review this diff against the rules in the project context. List: (1) any way plaintext
or private keys could reach the server, (2) missing tests, (3) anything outside the task
scope. Be specific with line references. Do not praise.
<paste `git diff main` output>
```

**When you do not understand generated code:**

```
Explain this code line by line as if to a student who will be questioned on it in a viva.
Then give me two questions an examiner might ask about it and the answers.
<paste>
```

### 3.4 What to do with what Gemini gives you

1. **Read every line before pasting it in.** If you cannot explain a line, ask the explain prompt. You will be asked about this code by the jury.
2. **Check imports exist.** Gemini invents functions. If `pip install` or `npm install` for something it suggests fails, or the import is red in VS Code, it may not be real.
3. **Run the tests it wrote.** If they pass on the first try, read them again; tests that cannot fail are not tests.
4. **Reject shortcuts that break the rules.** Common ones it will offer: storing message text as a string column "for now", logging the request body, skipping JWT on the WebSocket "for testing", using `any` in TypeScript. Say no and ask for the compliant version.
5. **Keep Gemini out of the commit.** Commit messages, PR descriptions and ClickUp comments are written by you in your words. They are short anyway.

---

## Part 4. Role notes

### Vineeth (backend)

- New table or column: write the model in `backend/app/models/`, import it in `app/models/__init__.py`, then:

```bash
alembic revision --autogenerate -m "P1.1 users table"
alembic upgrade head
alembic downgrade -1 && alembic upgrade head     # prove both directions work
```

Read the generated migration before committing it. Autogenerate misses enums and indexes sometimes.

- Every router goes in `backend/app/api/` and is registered in `app/main.py`.
- Every endpoint that touches a user's data uses the auth dependency. No exceptions after P1.4.
- Tests live in `backend/tests/`, one file per router. Use the `client` fixture from `conftest.py`.
- Open `http://localhost:8000/docs` to try endpoints by hand. FastAPI generates it.

### Maneesh (frontend and QA)

- Pages go in `frontend/src/pages/`, shared logic in `frontend/src/lib/`, components in `frontend/src/components/` (create it when you need it).
- Use the `@/` alias for imports: `import { API_URL } from "@/lib/api"`.
- Two users on one machine: use a normal window and an incognito window, or two Chrome profiles. Each needs its own IndexedDB, so two tabs in the same window will not work for two accounts.
- Every screen you build must handle three states: loading, error, empty. The jury will click fast.
- Screenshots for PRs: full browser window, both users visible when the feature is about two people.
- For milestone recordings use Windows `Win+G` or OBS, 30 to 60 seconds, no narration needed.

---

## Part 5. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `DLL load failed ... filename or extension is too long` | Project path too long | Move the clone to `C:\dev\nullspace-vbit` |
| `esbuild` or `vitest` fails to start on `npm install` | Antivirus or partial install | Delete `node_modules`, run `npm install` again; if still failing, `npm install --ignore-scripts` then `node node_modules/esbuild/install.js` |
| `docker compose up` says port 5432 or 8000 in use | Another Postgres or server running | Stop it, or change the left-hand port in `docker-compose.yml` |
| `/health` shows `db: unavailable` | Database not ready yet or wrong `.env` | Wait 20 seconds; check `POSTGRES_*` values match compose |
| `git push` rejected, "protected branch" | You committed on main | `git checkout -b P1.1-fix && git push -u origin P1.1-fix`, then open a PR |
| CI red on `ruff` | Formatting or import order | `ruff check --fix .` then commit |
| CI red on `typecheck` | TypeScript error | Run `npm run typecheck` locally; fix the first error first |
| Merge conflict | Someone merged first | `git checkout main && git pull && git checkout your-branch && git merge main`, resolve, commit |

---

## Part 6. Weekly rhythm

- **Weekly demo to the guide**, 30 minutes, from `main`, logged under task P8.9. Whoever merged the most that week drives.
- **Milestone 1** (plaintext chat between two browsers) and **Milestone 2** (encrypted chat with ciphertext shown in the database) are recorded and attached to their ClickUp tasks.
- Review requests are answered within 24 hours.

## The three rules that never change

1. If it is not in a PR that passed CI and review, it does not exist.
2. The server never sees plaintext. Every design choice that would change that is refused.
3. You must be able to explain every line you commit. The jury will ask.
