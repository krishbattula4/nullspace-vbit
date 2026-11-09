# ADR-002: Authentication with Access and Refresh JWTs

- Status: accepted
- Date: 2026-11-09
- Task: P1.3

## Context

Nullspace requires an authentication mechanism for REST endpoints and subsequent WebSocket connections. Authentication must support stateless verification for high-throughput messaging while allowing timely revocation of user sessions. Key architectural questions include:
1. Token format and signing algorithm.
2. Token lifetimes and claim structure.
3. Refresh token rotation and reuse/theft detection strategy.
4. Transport mechanism (cookies vs. JSON response bodies).

## Decision

1. **Token Format & Signing**:
   - Both access and refresh tokens are JSON Web Tokens (JWT) signed with `HS256` using `python-jose` and a shared secret (`settings.jwt_secret`).
   - The signing algorithm is strictly locked to `HS256`; algorithm `"none"` and any other algorithms are rejected.
   - Claims include:
     - `sub`: user ID (UUID string).
     - `type`: `"access"` or `"refresh"`.
     - `jti`: unique identifier for the token (UUID4 string).
     - `iat`: issuance timestamp (UTC epoch seconds).
     - `exp`: expiration timestamp (UTC epoch seconds).

2. **Lifetimes**:
   - Access tokens have a short lifetime: `settings.jwt_access_minutes` (default 15 minutes).
   - Refresh tokens have a longer lifetime: `settings.jwt_refresh_days` (default 7 days).

3. **Single-Use Refresh Token Rotation & Theft Detection**:
   - Every issued refresh token is tracked in the `refresh_tokens` database table with its unique `jti`, `user_id`, `expires_at`, `revoked_at`, and `replaced_by_jti`.
   - Refresh tokens are strictly single-use. Rotating a refresh token via `POST /auth/refresh` atomically revokes the presented token (`UPDATE refresh_tokens SET revoked_at = now WHERE jti = :jti AND revoked_at IS NULL AND expires_at > now`) and creates a new access/refresh pair.
   - If an atomic update affects 0 rows because the token was already revoked, this event is treated as token reuse (theft). The server immediately revokes every active refresh token belonging to that user (`UPDATE refresh_tokens SET revoked_at = now WHERE user_id = :user_id AND revoked_at IS NULL`) and returns HTTP 401 with `{"detail": "refresh_reuse_detected"}`.

4. **Secret Configuration Enforcement**:
   - When `app_env` is not `"development"` or `"test"`, `Settings` raises a configuration validation error at startup unless `jwt_secret` is at least 32 characters long and not equal to `"change-me"`.

5. **Transport**:
   - Both access and refresh tokens are returned in the JSON response body (`POST /auth/login` and `POST /auth/refresh`).

## Alternatives considered

1. **HTTP-only SameSite Cookies**:
   - *Considered*: Transmitting tokens via `Set-Cookie` with `HttpOnly` and `SameSite` flags protects tokens from JavaScript access.
   - *Rejected for now*: The local development frontend runs on `http://localhost:5173` while the backend runs on `http://localhost:8000`. Cross-origin cookie handling across different ports requires complex cookie attributes (`SameSite=None; Secure`), local HTTPS certificates, or CORS reverse proxying in development. Returning tokens in the JSON response body simplifies the developer experience across independent dev servers.

2. **Stateful Access Tokens via Database Lookup**:
   - *Considered*: Validating access tokens against a database or cache table on every request allows immediate revocation of access tokens.
   - *Rejected*: Querying the database on every REST request and WebSocket frame incurs unnecessary latency and load. Using short-lived (15-minute) stateless JWTs achieves an optimal balance between performance and security.

## Consequences & Known Limitations

1. **XSS Exposure (Known Limitation)**:
   - Returning tokens in the JSON body means client-side JavaScript stores tokens (e.g. in memory or browser storage). If an attacker succeeds in executing cross-site scripting (XSS), script-readable tokens can be extracted. Mitigation relies on strict Content Security Policy (CSP), avoiding third-party scripts, and keeping the frontend dependency footprint minimal.
2. **Access Token Revocation Window (Known Limitation)**:
   - Access tokens are stateless and cannot be revoked before their expiration timestamp (at most 15 minutes). When a user logs out or reuse is detected, existing access tokens remain valid until their `exp` timestamp passes.
3. **Database Write on Refresh**:
   - Every refresh operation requires an atomic database write to rotate `jti`. This is acceptable given the infrequent refresh rate (every 15 minutes per active client).
