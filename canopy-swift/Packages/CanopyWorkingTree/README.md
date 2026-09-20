# CanopyWorkingTree

The durable model of one tree: `WorkingTree` and its node records whose content is a reference, `WorkingTreeStateStore` (disk on iOS, memory on the Mac), the snapshot bridge, `UpdateMachine` and `UpdateCoordinator`, durability, `SourceAdmissionQueue`, entry actions and transfer, and conflict review with its compiler. It is the code `conformance/client-state-machines.json` and `source-admission-queue.json` check; the TypeScript counterpart is `@overstory/client`.
