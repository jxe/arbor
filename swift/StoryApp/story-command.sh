#!/bin/sh
# The `story` command as Story.app ships it: the app's bundled Bun running the
# bundled CLI. Install Command Line Tool links /usr/local/bin/story to this file.
self=$0
while [ -L "$self" ]; do
  target=$(readlink "$self")
  case $target in
    /*) self=$target ;;
    *) self=$(dirname "$self")/$target ;;
  esac
done
resources=$(CDPATH= cd -- "$(dirname -- "$self")" && pwd -P)
exec "$resources/../../MacOS/story-sync" "$resources/story.js" "$@"
