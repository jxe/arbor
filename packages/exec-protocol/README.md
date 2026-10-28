# @ovst/exec-protocol

The contract between overstoryd and its execution sidecar, and nothing else: the
sidecar's handshake, the query and mutation questions overstoryd asks, and their
answers. It holds no evaluator, compiler or authored code.

overstoryd and `@ovst/overstoryd-exec` both depend on this package; overstoryd
depends on no other execution code. [The execution sidecar](../../docs/architecture/overstoryd/execution-sidecar.md)
is the API on one page.
