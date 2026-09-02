# 000: simplified wire (2026-09-02)

**Status:** done. The Railway Canopy, the Mac, and the iPhone were migrated on 2026-09-02.
This directory holds the migration's code, moved out of `packages/canopy` so the product code
carries nothing migration-shaped. Delete the whole directory once the backups under
`~/arbor-migration-2026-09-02/` are gone (planned for about 2026-09-16).

Its test is skipped: the current build requires schema version 3 and this migration produces version 2, so it only runs under the build it shipped with.
