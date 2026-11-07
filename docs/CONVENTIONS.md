# Conventions and Definition of Done

## Branches and commits

- One branch per ClickUp task, named `<TaskID>-short-name`, e.g. `P2.3-message-router`.
- Branch from a freshly pulled `main`. Never commit directly to `main`.
- Commit messages start with the task ID: `P2.3: persist message and version 1`.
- Squash-merge pull requests. Delete the branch after merge.

## Pull requests

- One PR per task. Use the PR template: task link, acceptance criteria ticked, evidence attached.
- CI must be green before review is requested.
- Reviewed by a different member: Vineeth -> Sitanshu -> Maneesh -> Vineeth. The reviewer pulls the branch and runs it once.
- The author moves the ClickUp task to Complete and pastes the PR link as a comment.

## Definition of Done

A task is done only when all of these hold:

1. Every acceptance criterion in the ClickUp task is demonstrably met.
2. Tests exist for the behaviour and pass in CI (pytest for backend, vitest or Playwright for frontend).
3. Evidence (screenshot, recording or test output) is attached to the PR.
4. `docs/` is updated if the protocol, schema or workflow changed.
5. No plaintext message content, private key or file key can reach the server through the change.
6. No secrets are committed. `.env` stays local; `.env.example` is updated when a variable is added.

## Code style

- Python: ruff (line length 100), type hints on public functions, async everywhere in request paths.
- TypeScript: strict mode, ESLint + Prettier, no `any` without a comment explaining why.
- Names: tables and columns `snake_case`, TypeScript `camelCase`, React components `PascalCase`.

## Security rules that never change

- The server stores ciphertext in BYTEA columns only. No text column may hold message content.
- Private keys live in the browser's IndexedDB. They are never logged, exported unencrypted, or sent anywhere.
- Every WebSocket connection and REST call after login carries a JWT.
- Only the sender may edit, delete or retract their message. Enforced on the server, not only in the UI.
