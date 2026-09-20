# Native source-admission cutover — 17 September 2026

Tested Native revision `8f0a47a` is installed on the Mac and physical iPhone.
Canopy's required [merged-predecessor acceptance](merged-successor-deployment.md)
is already deployed; its schema remains 11. The app transition uses the existing
local coordinator schema 3 for source-mode records.

## Backups and installation

The user closed both apps before installation. Private evidence is retained at
`/Users/joe/arbor-native-source-cutover-20260917/`:

- `mac-state` contains the complete `.arbor` copy, with 12 SQLite databases
  replaced by consistent SQLite backups and checked for integrity.
- `mac-app-before` retains the previous Mac app. The previous bundle also remains
  next to the installed bundle as `Arbor-before-source-cutover-20260917.app`.
- `iphone-container/Library` retains the phone's application Library, including
  its active coordinator and historical format-recovery material. Both SQLite
  databases passed integrity checks. The Documents inventory was empty.
- Per-file SHA-256 manifests and installation reports are retained with the backups.

Both Mac coordinator records and the active phone coordinator had no legacy head,
request, conflict, hold or next base. The phone coordinator bytes were unchanged
across backup. The Mac install preserved the existing `/Applications/Arbor.app`
symlink and replaced its target with the tested signed bundle. Bundle content
hashes match. Device tools confirmed installation of `org.nxhx.Arbor` on the phone.
Neither app was launched by the installer.

## Verification complete

Both reopened console coordinators selected source mode and wrote local schema 3
without legacy work. The user confirmed both apps load normally. Real cross-device
source publication and restart verification passed; temporary page
`Arbor source sync check.md` was created at accepted update `2150` for that check.
The Mac's edits were accepted as `editSource` updates `2151`–`2153`, with exact
source bases and operation evidence retained, no conflicts, and no pending request.
Phone edits were accepted as `editSource` updates `2154`–`2156`. Both devices
retained their own change receipts and reached the same exact accepted and local
root, with no pending request or conflict. Cleanup update `2157` removed only the
temporary page and restored the original root. After the user restarted both apps and refreshed the phone, both retained all
three source receipts, reported current state with no pending/legacy work, and
matched cleanup root `sha256:1bd4734380371ab001c2a9183007d8a3f962b4bfc122055931421f9d9420c75f`.
Authenticated reads of all three installed placements and full production integrity
verification passed. The user confirmed both restarted apps load normally. The other Mac coordinator was not
opened and remains in its existing schema 2 state; it will select source mode when
opened if its legacy work is settled.

The installed-client gate is passed. Removing compatibility recovery and its UI
is the remaining cleanup in [008](../plans/canopy-swift/008-complete-native-move-copy-undo-capture.md).
Do not restore an older snapshot-only app over an active source journal: it cannot
publish that journal. Backups are recovery evidence, not permission to discard
work accepted or authored after the cutover.
