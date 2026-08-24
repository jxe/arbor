# Plan 020: Complete device-management browser E2E

> **Executor instructions**: Add focused browser automation for the already shipped pairing and device-management surface. Treat Plan 010's protocol, security model, and production behavior as fixed. Never expose a pairing secret or device credential in snapshots, traces, logs, failure messages, or checked-in fixtures.
>
> **Drift check**: `git diff --stat 664f43b..HEAD -- packages/render packages/arbord packages/wire tests/e2e playwright.config.ts plan/native/010-add-device-pairing.md`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MEDIUM
- **Depends on**: Plan 010
- **Category**: browser hardening
- **Planned at**: Arbor `664f43b`, 2026-08-24
- **Progress**: TODO — deliberately deferred from Plan 010 after protocol/runtime, Hetzner, migration, and live Railway revocation verification passed.

## Why this matters

The device protocol and browser surface are already implemented and live-verified. A small focused browser suite should now protect the human flow—confirmation, one-time claim, safe device listing, and revocation—without keeping native implementation or the completed production migration blocked on UI automation.

## Scope

**In scope**: pairing entry from the account surface, confirmation-code presentation, safe QR/payload handling, successful claim simulation through the test authority, active-device listing, explicit revoke confirmation, revoked-state refresh, and browser-visible failure handling for used/expired/wrong secrets.

**Out of scope**: protocol or schema changes, production migration, native scanner/UI, all-device-loss recovery, account redesign, and exposing raw secret values to Playwright artifacts.

## Steps

1. Add a pairing-specific Playwright fixture whose authority and credentials are disposable and whose traces/screenshots contain only redacted or safe values.
2. Prove the account surface creates one offer, shows the confirmation code, and represents the versioned QR payload without placing the existing account credential in it.
3. Claim the offer through the test boundary, refresh the device list, and verify the new safe label/metadata appears exactly once.
4. Revoke that device through explicit confirmation, verify the UI updates, and prove the revoked credential is denied without logging it.
5. Cover one-use replay plus wrong/expired-secret messages and confirm cache refresh does not resurrect stale active-device state.

## Verification

```sh
bun run test:e2e
bun run typecheck
bun run build
git diff --check
```

## Done criteria

- [ ] The complete browser pairing/list/revoke flow passes without secret-bearing artifacts.
- [ ] Used, expired, and wrong-secret states are understandable and deterministic.
- [ ] Revocation is visible after refresh and the revoked credential remains denied.
- [ ] Plan 010 remains closed; failures here do not introduce a second device protocol.

## STOP conditions

- A test would persist or print raw pairing/device/account credentials.
- Browser automation requires weakening expiry, single-use, digest-only storage, or revocation behavior.
- The work expands into native pairing UI or account recovery.

## Maintenance note

Keep this a small browser contract around Plan 010's shipped behavior. If the account surface is redesigned later, update selectors and presentation assertions without duplicating protocol tests already owned by authority and wire suites.
