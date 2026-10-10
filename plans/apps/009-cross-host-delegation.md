# Apps 009: Code on one host using access held on another

**Why and when:** after Apps 008, once apps span hosts. A design sketch; no timing yet.

## Status

- **Effort:** L
- **Risk:** HIGH. It defines delegated authorization across servers, which the
  spec defers.
- **State:** DESIGN SKETCH 2026-09-27, split from the portable-profiles design
  (Security 008). Waits on hosted code
  ([Apps 005](005-source-resolution-and-sidecar.md)) and
  [Apps 008](008-app-approvals-on-placement-hosts.md). One decision is Joe's
  (marked **Decide**).
- **Closes:** the spec's deferred item 2, delegated authorization and
  server-to-server execution routing
  ([deferred](../../docs/overstory-spec/README.md#deferred)).

## The problem

Code runs on host R, and a resource it needs is on host S. Execution tokens
are host-private ([access control §2.1](../../docs/overstory-spec/05-access-control.md#21-execution-tokens)),
so S cannot tell who is calling, which code runs, or whose lend applies.

## The design

**The caller authorizes the crossing.** Hosts have no identities, and adding
host keys is what this avoids. At the start of an execution that needs a
resource on S, the caller's device signs an **execution grant**: the caller's
profile and DeviceID, the app TreeID and pinned code root, the requirements on
S, S's origin as the audience, and an expiry. R forwards it with each call to
S. S verifies the device signature against the caller's device keys (from the
caller's home host, as a placement host does), verifies any lend against the
lender's `apps.yaml` (as Apps 008 reads it), and enforces its own
`access.yaml` as always. What S trusts R for is only to run the pinned code,
which lending already trusts the app's administrators to do.

**Decide:** what waits. Anonymous callers, and lends to `everyone` callers,
have nobody to sign, and would need host identities. Recommended: v1 is
caller-signed only; those stay same-host until someone needs them.

## Work

- Once Apps 005 defines the execution context: record the grant's format,
  its lifetime and revocation (a revoked device or lend ends the execution on
  S, as on one host), and how a long-running or resumed execution renews it;
  then spec (executable documents §12.3, access control §1.1 and §2.1, the
  deferred list), overstoryd on both roles, and a two-host test.
