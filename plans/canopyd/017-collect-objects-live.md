# canopyd 017: Run the object collector live

## Status

- **Priority:** P2
- **Effort:** S
- **Risk:** MEDIUM — it deletes from the live volume; every step is gated on Joe
- **State:** READY; the collector is implemented and rehearsed (see
  [status](../../status.md#known-gaps), "Storage is unbounded")
- **Depends on:** the collector's commit deployed (it changes `ObjectStore` to
  freshen reused objects and acceptance to freshen objects it takes from the
  store; the collector is only safe beside a canopyd that does both)

## Decided

The collector runs through `railway ssh`, started by hand or by a cron on
Joe's side ([deployment](../../packages/canopyd/deploy/README.md#collecting-unreferenced-objects)).
There is no in-process timer and no admin route. A separate Railway cron
service cannot mount the volume, which attaches to one service.

## Work

1. Deploy the revision that contains the collector and the freshening
   changes. It changes no schema and no wire format.
2. Back up (the migration procedure's step 1 and 2), then run the dry run
   live and compare it with the rehearsal: live objects should be the
   rehearsal's plus whatever was accepted since.
3. With Joe's go-ahead, run with `--delete` and the default 24-hour grace.
   Then call `/.arbor/integrity` once.
4. Schedule the same command (daily or weekly) from Joe's machine or another
   host with the Railway CLI linked. Keep each report.
5. Delete this plan and record the live numbers in `status.md`.

## Open decision: document-version retention

`document_versions` keeps every accepted body of every Markdown document,
independent of accepted history. On the 2026-09-24 backup that is 2,683
bodies, 106 MB of the 116 MB the collector keeps, almost all of them
versions of one 60 KB `_index.md`. The collector keeps them because
[canopyd 007](007-document-history-routes-and-restore.md) will serve them.
Choosing a bound (for example keep every version for N days, then thin to one
a day) is a product decision for canopyd 007; once made, a pruning of
`document_versions` rows lets the next collection reclaim the bodies with no
collector change.
