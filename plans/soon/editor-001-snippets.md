# Editor 001: snippets you type or say

**Why and when:** Joe plans his day in Story on the iPhone as time rows ("9–11") with tasks
under them, mostly by voice. On 2026-10-24 he asked for TextMate-style snippets instead of
template buttons: a piece of page he keeps and edits like any other, such as his standard day
outline, which expands where he is when he types or says its name. Template buttons go away
with no migration. Shifting the hours after expanding is already handled by time rows (a
Quagmire extension; changing a row's end moves every later row). Worked out in the thread
"Design time rows and snippets for day plans".

> **Executor instructions**: Settle the forks at the end with Joe first. Then refresh "What
> happens today" against the source, and stop after each phase for Joe's hands-on check on
> the iPhone.

## Status

- **Effort:** M.
- **Risk:** LOW. Expansion is an ordinary insert; the only file format question is the
  property that marks a snippet.
- **State:** TODO, forks open.
- **Relates to:** time rows (QuagmireExtras), which a day snippet is mostly made of; pinch
  dictation (`EditorPinchDictation`), which the spoken trigger hooks into.

## What happens today

Written against arbor `origin/main` of 2026-10-24 and Quagmire 0.12.

- Quagmire has a `.templateButton(label:)` block: a "+ label" row whose children are copied
  in when pressed (`instantiateTemplateButton`). It's in Turn Into as "Template". Story's
  `MarkdownCodec` writes it as a plain `- label` bullet, so a template button does not
  survive a reload as one; in practice nobody uses it.
- The @ menu (`MentionTrigger`, `MentionSearch`, `EditorView+Mention`) completes page links
  from the host.
- A pinch-open on the iPhone records, transcribes, and inserts the transcript as one block
  (`EditorView+Pinch.swift`); `TranscriptPolisher` tidies it on device.
- Spec 02 treats a page's YAML frontmatter as its node properties, written through the
  property write (spec 01). Check what Story reads and writes of them today.

## The design

**A snippet is a page with a `snippet` property.** Any page becomes a snippet by having
`snippet: day` in its frontmatter. Its body (everything after the title heading) is what gets
inserted. The page lives wherever it makes sense, is edited in the normal editor, syncs and
shares like any page, and needs no special folder. Story offers "Make Snippet…" in the page
menu, which asks for the name and writes the property; the page's title row shows a small
"snippet: day" badge so it's clear what it is.

Why a property rather than a Snippets folder: a folder means a naming rule per tree and
pages that only work in one place; a property travels with the page if it's moved, and
works in any tree. Why not a list of snippets inside one page's frontmatter: snippets are
outlines with nesting, which YAML strings hold badly and nobody can edit comfortably.

**Story finds snippets** in every tree placed on the device, by indexing pages whose
frontmatter has `snippet`. Two snippets with the same name: the one in your own profile tree
wins, then the most recently edited.

**Typing:** snippets appear in the @ menu in their own "Snippets" section, matched by name
("@day"). Picking one replaces the `@day` text with the snippet's blocks at that point,
indented to the current level, as one undo step. Nothing expands from plain typed words, so
"day" in a sentence never surprises you.

**Saying:** a pinch recording whose whole transcript, after polishing and dropping
punctuation and case, is a snippet's name inserts the snippet instead of the words. A toast
says "Inserted snippet day" with Undo, which puts the spoken word back. Optionally the name
may be preceded by "snippet" ("snippet day"), which always expands and lets a name collide
with a common word. See fork 2.

**Expansion** copies the blocks with fresh IDs (same rule as paste). The first version has
no placeholders; time rows expand as written, and Joe drags the first row's end to shift the
day. `{{date}}` and "start at the next hour" are listed as follow-ups.

**Template buttons are removed** from Quagmire: the block kind, its row, Turn Into entry,
`expandedTemplates`, and instantiation. A `- label` bullet stays a bullet, which is what
Story already writes.

## Phases

1. **Quagmire: remove template buttons; add `insertBlocks(at:)` for hosts.** The host API
   inserts copies at the cursor (or replacing a text range in the editing block, for @),
   re-indented, as one transaction. Tests for both.
2. **Story: index snippets and complete them in @.** Index from frontmatter across placed
   trees; a Snippets section in the @ menu; "Make Snippet…" in the page menu and the title
   badge.
3. **Spoken trigger.** Match the finished pinch transcript against snippet names before
   inserting; toast with Undo.
4. **Spec.** Add the `snippet` property to spec 02's known properties, as an optional
   string that clients may ignore.

## Forks for Joe

1. **Where the marker lives.** Recommended: a `snippet: <name>` frontmatter property on the
   page. Alternative: a Snippets folder in your profile tree with the page title as the
   name (no frontmatter, but one fixed place and a naming rule).
2. **The spoken trigger.** Recommended: the whole recording is just the name ("day"), with
   "snippet day" also accepted. Alternatives: require the "snippet" prefix always (never
   surprising, more to say); or let the on-device model pick a snippet from looser speech
   ("give me my usual day"), which is friendlier but can guess wrong.
3. **Which trees count.** Recommended: every tree placed on this device. Alternative: only
   your own profile tree, so shared trees never add snippets.
