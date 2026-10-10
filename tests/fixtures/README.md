# Reference implementation fixtures

These fixtures test the reference implementation rather than defining the portable specification:

- `story-sync/` covers the reference control surface (status, bootstrap, credential, conflicts) and local event model;
- `overstoryd/` covers overstoryd's exact merge algorithm; and
- `workspace/` contains authored files used by implementation tests.

Portable language-neutral vectors live under [`conformance`](../../conformance).
