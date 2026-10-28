# Groups that are other trees

**Touches:** spec 11 (views and groupings), 04 (group profile trees and their `members`).

**The extension.** A grouping whose groups are group profile trees and whose members are each
tree's `members`, read and edited there: dragging a contact under a group heading adds the
person to that group's tree, and removing takes them out. The People directory keeps no copy
of membership; it is the same "edits go back to the source" rule as
[pages that present other collections](pages-that-present-other-collections.md), with a tree's
member list as the source.

**Open.** How a schema or view names such a grouping, and how a client learns which group trees
it may edit.

**Settled.** Groups stay group profile trees on hosts, because sharing needs them there
([People 001](../features/people-001-groups-sharing-and-go-to.md)). Today the directory's
`Tie` rows (kind `Group` or `Community`) show the groups, read-only. The drag itself is
[Schema language 007](../soon/schema-language-007-edit-collections-in-story.md)'s editor.
Formerly part of Schema language 002's milestone 2, moved here on 2026-10-28.
