# App icon options

These full-resolution masters preserve the icon directions explored while the app was named Canopy.
They are reference assets and are not included in the app bundle.

| Master | Direction | Status |
| --- | --- | --- |
| `AppIcon-crescent-v5-1024.png` | Oblique, even-height overstory in a crescent silhouette | Previous app icon |
| `AppIcon-woodland-island-v5-1024.png` | Irregular woodland-island silhouette | Option |
| `AppIcon-perspective-trapezoid-v5-1024.png` | Geometric perspective-trapezoid silhouette | Option |
| `AppIcon-oblique-overstory-v4-1024.png` | Broad, level oblique overstory | Option |
| `AppIcon-oblique-grove-v3-1024.png` | Earlier compact oblique grove | Option |

The active icon's platform renditions live in
`../Assets.xcassets/AppIcon.appiconset/`. Keep a master here when promoting a
different option so the alternatives remain available for comparison.

## Story icon choices

`Story-PageS-master.png`, `Story-StoryPath-master.png`, and
`Story-Doorway-master.png` are the square source artwork for the three app
icon choices. Story Path (Black) is the primary icon; Page S and Doorway are
iOS alternate icons. The previous `StoryPath` alternate name is retained as an
alias for compatibility with devices that selected it before the default changed. They were prepared with the built-in imagegen tool from
the approved concept sheet: retain the thick ivory sheaves for Page S, use a
continuous black background for Story Path, and preserve the glowing doorway
in the open book for Doorway. All masters have square, full-bleed backgrounds
so iOS applies its own corner mask.

Run `swift swift/scripts/prepare-story-icons.swift` from the repository root
to regenerate asset renditions. Mac renditions use transparent outer margins
and a rounded tile; iOS renditions are opaque and fill the square. The matching
`StoryIcon*.imageset` assets supply the Mac's runtime Dock icon.

On Mac, Story > App Icon changes the running Dock icon and restores the
per-device preference at launch; it does not change the app bundle's Finder
icon. On iOS, the top-left App Icon toolbar menu in Sync & Accounts uses the system alternate-icon API
and its system confirmation. Choices are device-local and independent of
accounts.

Story Path's revised master has broader, softer paper corners that sit inside
the iOS mask. `Story-StoryPath-v1-master.png` preserves the earlier artwork.
The black background remains full bleed; no iOS corner mask is baked in.
