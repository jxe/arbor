# History and revision support

Joe wants history, revision browsing, restoration and attribution plans together.
These plans share accepted history and retention rules; implement the history
reader before building line attribution on it.

1. **[007: Document history and restore](007-document-history-routes-and-restore.md).**
   Parked. Seeing and restoring earlier versions of a page; it also decides how
   long document versions are kept, which is most of what overstoryd retains.
2. **[006: Line provenance](006-line-provenance.md).**
   Parked, after 007: show who submitted each current line, with the limits of
   that attribution made explicit.

The numbers retain their overstoryd identifiers. The plans remain separate because
line attribution depends on the history API and adds its own metadata and policy.
[Merge explanations](../merge/README.md) can link to this history; their provenance
proofs and conflict-resolution rules belong with merge work.
