# StoryKit

The app's own pieces on top of the client library's workspace module
([`OverstoryWorkspace`](../OverstoryWorkspace/README.md)): `WorkspaceCoordinator`
and document leases, `DraftDocumentSession`, `InMemoryWorkspaceProvider` (also
the test fixture), title slugs, cross-tree page moves, and
`BrowserTabController`. It re-exports `OverstoryWorkspace`, so app code imports
StoryKit alone. Depends on OverstoryWorkspace only.
