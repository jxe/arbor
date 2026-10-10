# @ovst/merge-protocol

The contract between overstoryd and a merge sidecar, and nothing else: the log
entry overstoryd stores for each accepted update (canonical JSON in the object
store), the log decision, the one merge question and its answer, and the
refusal codes. It holds no merge logic and no knowledge of any sidecar's cache.

overstoryd and `@ovst/overstoryd-merge` both depend on this package; overstoryd
depends on no other merge code. [Writing a sidecar](../../docs/architecture/overstoryd/writing-a-sidecar.md)
is the API on one page; the process, limits and failure behavior are in
[the merge sidecar](../../docs/architecture/overstoryd/merge-tool.md).
