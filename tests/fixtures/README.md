# Reference implementation fixtures

These fixtures test the current Arbor implementation rather than defining the portable specification:

- `arbord/` covers the reference REST API and local event model;
- `client/` covers local filesystem, `system:`, legacy, and external-link resolution behavior;
- `authority/` covers the reference authority's exact merge algorithm; and
- `workspace/` contains authored files used by implementation tests.

Portable language-neutral vectors live under [`conformance`](../../conformance).
