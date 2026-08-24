# Plan 010: Add revocable device credentials and pairing

> **Executor instructions**: Separate device authorization from profile identity. Never expose or log a raw account, device, access-link, or pairing secret. Work only against local/test authorities; Plan 011 owns production rollout.
>
> **Drift check**: `git diff --stat dc34126..HEAD -- packages/authority/src packages/wire/src packages/render packages/core spec/wire.md spec/system.md tests`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plan 008
- **Category**: security/product
- **Planned at**: Arbor `dc34126`, 2026-08-23
- **Implementation status**: COMPLETE — distinct device credentials, one-use pairing, provenance, revocation, TypeScript/Swift client support, and the browser management surface are implemented. Focused browser automation of that existing surface is intentionally deferred to Plan 020 rather than keeping this protocol/runtime unit open.
- **Verified at**: Arbor `664f43b`, 2026-08-24 (`bun run test`, `bun run test:protocol`, `swift test` through the protocol harness, the general `bun run test:e2e` browser regression suite, `bun run typecheck`, `bun run build`, `git diff --check`, four-host Hetzner qualification, isolated restored-volume migration/restart, live Railway credential authentication, and a live one-use pairing/read/revoke/`401` denial smoke)
- **Production status**: live on Railway. The two existing account credentials became two unrevoked `Initial device` records without changing account/profile identity or credential validity; the maintained runtime contains no credential-backfill path.

## Why this matters

The native app needs an ordinary way to authorize iPhone/iPad without copying the existing broad account token. Distinct device credentials make loss, replacement, and revocation understandable while preserving the profile tree as stable person identity.

## Current state

- Authority bearer credentials resolve through distinct device records. Existing production credentials were converted to initial devices by Plan 011's temporary migration release; current startup validates the device invariant and performs no backfill.
- Raw credentials are already excluded from content, refs, objects, diagnostics, logs, and safe system records.
- The web/account surface implements pairing creation plus device listing/revocation, and both TypeScript and Swift authority clients consume the same endpoints.

## Interface

- Authenticated create-pairing endpoint returns a pairing ID, high-entropy one-time secret, expiry, and short confirmation code.
- Unauthenticated but rate-limited claim endpoint consumes the ID/secret and proposed safe device label, then returns a distinct device credential exactly once.
- Authenticated list/revoke endpoints expose safe device ID, label, created/last-used time, and current/revoked state—never token material.
- Pairings expire after ten minutes, are single-use, and store only secret digests.
- The QR payload is versioned structured data, not an ordinary Arbor/navigation URL; both devices display the derived confirmation code.

## Scope

**In scope**: device/pairing schema, authentication resolution, endpoints/TypeScript client types, web pairing/list/revoke UI, migration of existing account credentials to an initial device, tests/spec.

**Out of scope**: Swift scanner/UI, account recovery after all devices are lost, end-to-end encryption, production rollout, and the focused browser automation now owned by Plan 020.

Production credential upgrade used Plan 011's backed-up, isolated restored-volume rehearsal and live migration release. There is no separate pairing migration or rollback tool, and the compatibility code is no longer present in the maintained runtime.

## Steps

1. Add device and pairing tables with unique IDs, hashed credentials/secrets, expiry/use/revocation fields, and account foreign keys.
2. Route existing credential authentication through device records while preserving current credentials during migration. Expose one stable internal credential-subject/device ID to derived-request replay scope and accepted-update provenance; never use the mutable display label.
3. Implement create/claim/list/revoke with transaction-safe single use, constant-time digest comparison, rate limits, and `no-store` responses.
4. Add safe diagnostic/audit events that identify device IDs but redact all secret material.
5. Add the web **Pair a device** flow, confirmation code, active-device list, and explicit revoke confirmation.
6. Add fixtures/tests for expiry, replay, concurrency, wrong secret, disabled account, revoked token, cache refresh, and redaction.

## Verification

```sh
bun test tests/integration/authority/community-hosting.test.ts tests/integration/authority/update-host.test.ts
bun run typecheck
bun run test:e2e
bun run build
git diff --check
```

Expected: one concurrent claim wins; reuse fails; revocation blocks subsequent reads/update submissions; exact request replay continues to resolve to the same authenticated device; existing test credentials still work; secret literals never appear in captured logs/responses beyond the one authorized issuance response.

## Done criteria

- [x] Every installation can have a distinct revocable credential.
- [x] Pairings are short-lived, one-use, digest-only at rest.
- [x] Existing accounts/profile TreeIDs do not change.
- [x] The web pairing and revocation surface is implemented; its focused browser E2E hardening is separately scoped in Plan 020.

## STOP conditions

- Pairing requires embedding the existing account credential in the QR payload.
- Revocation cannot invalidate cached authorization promptly.
- Safe migration would strand the only existing credential.

## Maintenance note

All-device-loss recovery remains a separate account-lifecycle topic. Do not quietly turn the pairing secret into a durable recovery secret. Plan 020 may automate the shipped browser flow but must not redesign this protocol or reopen production migration.
