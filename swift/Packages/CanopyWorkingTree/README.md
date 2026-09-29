# CanopyWorkingTree

The durable model of one tree: `WorkingTree` and its node records whose content is a reference, `WorkingTreeStateStore` (disk on iOS, memory on the Mac), the snapshot bridge, `UpdateMachine` and `UpdateCoordinator`, durability, `ChangeLog`, entry actions and transfer, and conflict review with its compiler. It is the code `docs/overstory-spec/conformance/client-state-machines.json` and `source-admission-queue.json` check; the TypeScript counterpart is `@overstory/working-tree`.

`ChangePublication` composes unsent records and repeated pure moves while retaining
local change and operation-result identities. `UpdateMachine` defaults to 250 ms
of idle, with an optional maximum for continuously active sources. Watch and poll
traffic respect that window; prepared requests remain exact across restart.
