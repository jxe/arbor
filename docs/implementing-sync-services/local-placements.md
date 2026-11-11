# Reference local placements

This is an informative layout for local synchronizers. The portable
[placement requirements](../overstory-spec/2.2-placements-on-disk.md#7-local-placements)
keep local paths outside synchronized content. See [implementation status](../../status.md)
for current coverage and [the data home](../architecture/story-sync/data-home.md)
for the daemon's storage.

The reference layout groups local placements by configuration
`TreeID`, then maps canonical absolute local paths directly to hosted `TreeID`s:

```yaml
# ~/.story/placements.yaml (informative, not portable Overstory content)
tr_config_a:
  "/Users/joe/Documents/Notes": "tr_notes"
tr_config_b:
  "/Users/joe/Documents/Sketches": "tr_sketches"
```

There is no top-level wrapper or format version. Grouping by configuration
`TreeID`, rather than origin, permits several accounts at one host and
survives a host-domain change. A value widens to a mapping when a
placement-specific option is needed: the reference daemon's are `host`, for a
tree at another host, and `access: read`, for a read-only placement that
follows a tree it never publishes to
([the data home](../architecture/story-sync/data-home.md#placementsyaml)). An Overstory-managed working tree that keeps its own state on disk (iOS)
is still a real local path, normally beneath private state, and follows the
same one-path-to-one-tree rule. A working tree that borrows a placed folder's
object store instead of holding one (the Mac app opening a folder the daemon
has placed) has no path of its own and is not a placement: the folder is the
placement, and that working tree is one more client of the same tree. This
reference layout does not make OS paths portable or synchronized.
