# Plan 010: Add revocable device credentials and pairing

> **Executor instructions**: Separate device authorization from profile identity. Never expose or log a raw account, device, access-link, or pairing secret. Work only against local/test authorities; Plan 011 owns production rollout.
>
> **Drift check**: `git diff --stat dc34126..HEAD -- packages/wire/src/authority.ts packages/wire/src/host.ts packages/wire/src/client.ts packages/render packages/core spec/wire.md spec/system.md tests`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plan 008
- **Category**: security/product
- **Planned at**: Arbor `dc34126`, 2026-08-23

## Why this matters

The native app needs an ordinary way to authorize iPhone/iPad without copying the existing broad account token. Distinct device credentials make loss, replacement, and revocation understandable while preserving the profile tree as stable person identity.

## Current state

- Authority accounts currently authenticate through configured bearer tokens associated with account records.
- Raw credentials are already excluded from content, refs, objects, diagnostics, logs, and safe system records.
- The web/account surface can host pairing and device-management UI before the Swift app exists.

## Interface

- Authenticated create-pairing endpoint returns a pairing ID, high-entropy one-time secret, expiry, and short confirmation code.
- Unauthenticated but rate-limited claim endpoint consumes the ID/secret and proposed safe device label, then returns a distinct device credential exactly once.
- Authenticated list/revoke endpoints expose safe device ID, label, created/last-used time, and current/revoked state—never token material.
- Pairings expire after ten minutes, are single-use, and store only secret digests.
- The QR payload is versioned structured data, not an ordinary Arbor/navigation URL; both devices display the derived confirmation code.

## Scope

**In scope**: device/pairing schema, authentication resolution, endpoints/client types, web pairing/list/revoke UI, migration of existing account credentials to an initial device, tests/spec.

**Out of scope**: Swift scanner/UI, account recovery after all devices are lost, end-to-end encryption, production rollout.

## Steps

1. Add device and pairing tables with unique IDs, hashed credentials/secrets, expiry/use/revocation fields, and account foreign keys.
2. Route existing credential authentication through device records while preserving current credentials during migration. Expose one stable internal credential-subject/device ID to `sync-v1` idempotency and history; never use the mutable display label.
3. Implement create/claim/list/revoke with transaction-safe single use, constant-time digest comparison, rate limits, and `no-store` responses.
4. Add safe diagnostic/audit events that identify device IDs but redact all secret material.
5. Add the web **Pair a device** flow, confirmation code, active-device list, and explicit revoke confirmation.
6. Add fixtures/tests for expiry, replay, concurrency, wrong secret, disabled account, revoked token, cache refresh, and redaction.

## Verification

```sh
bun test tests/integration/community-hosting.test.ts tests/integration/wire-host.test.ts
bun run typecheck
bun run test:e2e
bun run build
git diff --check
```

Expected: one concurrent claim wins; reuse fails; revocation blocks subsequent reads/syncs; exact request replay continues to resolve to the same authenticated device; existing test credentials still work; secret literals never appear in captured logs/responses beyond the one authorized issuance response.

## Done criteria

- [ ] Every installation can have a distinct revocable credential.
- [ ] Pairings are short-lived, one-use, digest-only at rest.
- [ ] Existing accounts/profile TreeIDs do not change.
- [ ] Web pairing and revocation pass E2E tests.

## STOP conditions

- Pairing requires embedding the existing account credential in the QR payload.
- Revocation cannot invalidate cached authorization promptly.
- Safe migration would strand the only existing credential.

## Maintenance note

All-device-loss recovery remains a separate account-lifecycle topic. Do not quietly turn the pairing secret into a durable recovery secret.
