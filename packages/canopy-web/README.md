# @overstory/canopy-web

Canopy for the browser: the web editor built with React, BlockNote, and Vite.
It is out of the build and typecheck until [Web 025](../../plans/canopy-web/025-arbor-web.md)
rebuilds it as a working-tree client over the same update and admission
machines as the Mac app; `bun run build:web` fails today for that reason.
The package stays a workspace member so its dependencies install and the
plan can start from a building tree.
