# Check 017: resource-only `trees.yaml`

Not a schema change. This release reads an account's `trees.yaml` only in the
resource-rule grammar (`who` / `allow` / `within` / `via`); the legacy
`subject` / `access` grammar and its dual-format handling are gone from the
protocol parser, canopyd and the CLI. An account whose current configuration
root still holds a legacy file would stop parsing after the deploy.

Before deploying, run the read-only check against a restored backup (step 3
of [the procedure](../README.md#the-procedure)):

```sh
bun run test:migration packages/canopyd/migrations/017-resource-policy-only
bun run packages/canopyd/migrations/017-resource-policy-only/check.ts before | tee policy-report.json
```

It opens the database read-only and exits nonzero if any active
account-configuration tree's current `trees.yaml` fails to parse. If the list
is empty, deploy normally; no migration step runs. If it is not empty, do not
deploy: rewrite each listed account's `trees.yaml` in the resource grammar
from a client first (each legacy `{ subject, access }` rule becomes
`{ who, allow: [access] }`), let it sync, and check again.

Only the current root matters for serving. An account-configuration update
whose base is an older legacy root is refused, because canopyd parses the base
to authorize the change; the client then retries on the current root.

Delete this directory once the release is deployed.
