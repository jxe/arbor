# Canopy storage project

This project reduces the physical cost of Canopy's retained immutable objects
and accepted transition history without changing Arbor Wire identity or
accepted-state semantics.

| Plan | Outcome | Priority | Status | Depends on |
|---|---|---:|---|---|
| [001](001-pack-object-storage.md) | Measure and replace expensive loose-object/history storage with an integrity-checked packed representation | P2 | NEEDS BASELINE AND DESIGN REVIEW | — |

The project is deliberately separate from general speed work. Packing changes
durability, recovery, verification, and pruning boundaries as well as read
performance, so it needs one storage-owned design and acceptance gate.
