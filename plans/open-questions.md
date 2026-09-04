# Open design questions

These are unresolved design questions, not hidden implementation status or executor-ready plans. When a question receives an accepted contract and concrete acceptance case, move the resulting work into the appropriate project index.

1. **Shared-tree recovery and endpoint movement.** How can a stable TreeID refresh endpoint hints durably and verifiably without recreating a central registry?
2. **Identity and recovery UX.** How should device replacement, profile recovery, and disputes prove control without turning local Arbor Sync into a multi-user account service?
3. **Merge semantics.** What backing-appropriate logical conflict semantics should structured collections and whole-database SQLite revisions use beyond text's three-way merge?
4. **Determinism discipline.** How should query and agent-tool runtimes isolate clock, randomness, I/O, and runtime upgrades from results claimed to be deterministic?
5. **Compiler correctness.** How should handle extraction, validator generation, realm separation, and access inference be independently verified as security boundaries?
6. **Schema evolution.** How should mounted consumers continue to work on older shapes while an Arbor tree or external database changes schema?
7. **Consent precision.** How should interfaces explain enforcement-true prefix declarations that are broader than the reads or writes a particular run performs, especially for computed paths?
8. **Cross-server executable data.** How should query discovery, delegated authorization, and server-to-server routing let an allowed document use remotely hosted data without treating network reachability as authority?
