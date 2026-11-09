# OverstoryWorkspace

The client library's workspace module (Clients 003, module 7): what an editor
or UI uses to read and edit a tree, whichever way the tree is held.
`WorkspaceProvider` and `WorkspaceDocumentSession`, the workspace models
(`WorkspaceReference`, `WorkspaceNode`, `TreeID`, …), logical URLs and Markdown
links, display titles, `EditorSource` (an editor as a source of local changes;
`docs/implementing-editors/editor-source.md`), source moves, and the schema
language's presented views (`USL/`). No dependencies.

The engine (`OverstoryWorkingTree`) and the accounts module (`OverstoryClient`)
build on it and import no app package; StoryKit re-exports it for the app.
