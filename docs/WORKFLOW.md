# Workflow: from ClickUp task to running application

## One-time

```bash
git clone https://github.com/krishbattula4/nullspace-vbit.git
cd nullspace-vbit
cp .env.example .env
```

## For every task

1. Pick the task in ClickUp (list *Nullspace Build*). Confirm nothing it is *waiting on* is still open. Move it to In Progress.
2. Branch from fresh main:
   ```bash
   git checkout main && git pull
   git checkout -b P2.3-message-router
   ```
3. Work. Commit small and often with the task ID in the message.
4. Run tests locally:
   ```bash
   cd backend && pytest
   cd frontend && npm run lint && npm run typecheck && npm test
   ```
5. Push and open a PR against main:
   ```bash
   git push -u origin P2.3-message-router
   ```
   Fill the PR template: task link, acceptance criteria ticked, evidence attached.
6. Wait for CI to pass. Fix red CI before asking for review.
7. A different member reviews (see CONVENTIONS.md), pulls the branch and runs it.
8. Squash and merge. Delete the branch.
9. In ClickUp: move the task to Complete, paste the PR link. Dependent tasks unblock.

## Running the application

```bash
docker compose up --build          # PostgreSQL + backend on :8000, migrations applied on start
cd frontend && npm install && npm run dev   # :5173
```

Use two browser profiles (or normal + incognito) so each user has its own IndexedDB key store.

## Weekly

- 30-minute demo to the guide from `main`, logged under task P8.9.
- Milestone 1 (plaintext chat) and Milestone 2 (encrypted chat with ciphertext shown in the DB) are recorded and attached to their tasks.

## Before the review

1. Freeze main one week before: bug-fix PRs only.
2. Tag: `git tag v1.0 && git push --tags`.
3. Run `scripts/plaintext_audit.py` and the latency measurement on the tag; results go into the report.
4. Record the demo video from a clean `docker compose up`.
5. Demo from the tag with two browser profiles and a psql terminal showing ciphertext rows.
