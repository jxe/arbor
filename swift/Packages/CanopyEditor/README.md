# CanopyEditor

The Quagmire editor host: `ArborEditorHost` and `ArborEditorSurface`, document binding and conflict analysis, the Markdown codec, and `EditorRecoveryStore` (described in `docs/architecture/arborsync/data-home.md`). It pins an exact Quagmire release; keep `Package.swift` and `project.yml` on the same version and test it only through `swift/scripts/test-canopy-editor-local.sh`.
