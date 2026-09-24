# @overstory/merge-protocol

The JSON contract between canopyd and its merge worker, and nothing else: the
request and response shapes of the `serve` protocol, the decision reports the
worker returns, the rule-evidence summaries canopyd persists, and the error
codes. It holds no merge logic and no knowledge of the worker's retained
state, which is opaque to canopyd.

canopyd and `@overstory/canopyd-merge` both depend on this package; canopyd
depends on no other merge code. The process contract, limits and failure
behavior are in [the merge tool](../../docs/architecture/canopyd/merge-tool.md).
