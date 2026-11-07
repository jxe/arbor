# Editor 002: dictate several items in one recording

**Why and when:** Joe dictates day plans on the iPhone with pinch recording, and one
recording makes one block, so a list of time rows and tasks takes a pinch per line. On
2026-10-24 he chose spoken breaks: saying "next item" ends the current item and starts a
new one, "next item indented" starts it one level in, and a third phrase starts it one level
out. A recording with no command stays one paragraph, which matters because he records
paragraphs a lot. Worked out in the thread "Design time rows and snippets for day plans",
alongside [Editor 001: snippets](editor-001-snippets.md).

> **Executor instructions**: Settle the forks at the end with Joe first. Refresh "What happens
> today" against Quagmire's source, and stop after each phase for Joe's check on the iPhone.

## Status

- **Effort:** M.
- **Risk:** LOW to MEDIUM. Misheard commands are the risk, so every split must undo in one
  step back to the plain transcript.
- **State:** TODO, forks open.

## What happens today

Written against Quagmire 0.12 plus the time-rows extension.

- Pinch-open on the iPhone inserts a block and records (`EditorView+Pinch.swift`). Sliding
  the pinch toward the trailing edge locks it; a locked pinch shows Heading, Indent and Stop,
  and a tap anywhere stops. Release inserts one block in the chosen style.
- `EditorPinchDictation` gives Quagmire live drafts and a final transcript; the host's
  `VoiceRecorder` runs `SpeechAnalyzer`/`SpeechTranscriber`, whose results carry audio time
  ranges. `TranscriptPolisher` tidies the final text on device.
- `applyPinchDictationCompletion` writes the transcript into the one inserted block.

## The design

**Three spoken commands**, recognized in the transcript as whole phrases between pauses or
punctuation, and removed from the text:

- "next item": end this item; the next is a sibling at the same level.
- "next item indented": the next item is one level deeper than this one.
- "next item out" (see fork 1): the next item is one level shallower.

A recording with commands becomes several blocks of the pinch's style (usually bullets)
starting where the pinch opened. Levels never go below the pinch's starting level or deeper
than one past the item above.

**Split before polishing.** The raw transcript is split at the commands first, then each
item is polished on its own, so the polisher can't merge items or rewrite a command.

**Live feedback.** While recording, the live draft already shows the split: each command
closes the current draft row and opens the next at its level, with a light haptic. If the
recognizer revises a volatile result and a command disappears, the draft rows merge back.

**Time rows fit in without extra work.** "9 to 11, next item indented, feel the loneliness,
next item out, 11 to 1 …" makes time rows with tasks under them, because a bullet that reads
as a time range is a time row.

**Undo** after a split recording first turns the items back into one block holding the
whole plain transcript (commands included), then removes it.

## Phases

1. **Split final transcripts.** A pure function from transcript to items with levels, with
   tests covering punctuation the recognizer adds ("Next item." "next item, indented"),
   commands at the very start or end, and false friends ("the next item on my list is…"
   stays text; see fork 2). Insert the items on finish as one transaction.
2. **Live drafts.** Show the split while recording.
3. **Mac.** The toolbar recording does the same.

## Forks for Joe

1. **The outdent phrase.** Recommended: "next item out", which is short and hard to mishear.
   Alternatives: "next item outdented" (parallel with "indented", but recognizers often
   mangle it), or "next item back".
2. **How strict matching is.** Recommended: a command counts only as its own phrase, so the
   recognizer has to put a pause or punctuation before and after it; "the next item on my
   list" stays text. Alternative: any occurrence counts, which never misses a command but
   sometimes splits a sentence.
3. **Gestures too?** Earlier ideas, not chosen yet: a two-finger tap as "next item" while a
   locked pinch records, and a two-finger swipe right or left to indent or outdent. A
   one-finger tap must stay Stop. Recommended: spoken commands only for now; add gestures if
   speaking them proves awkward in public.
