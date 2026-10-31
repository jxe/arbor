# Live 002: exact carets and selections, for people and agents

**Timing:** Later, after [Agents 001](agents-001-presence-and-a-first-agent.md).

**Why and when:** Agents 001 shows presence at block level: a person's or agent's mark sits
on the block holding their caret. Joe asked on 2026-10-30 for exact carets and selections as
their own plan, covering people and agents alike: you see the precise spot someone is typing,
the text they've selected, and the exact text an agent is reading or editing. This was
Live 001's phase 6 and part of the agents work.

> **Executor instructions**: Refresh "What happens after Agents 001" against the code as
> built. This needs a Quagmire release, which ships with an arbor release, never alone (see
> DEVELOPMENT.md). Stop after each phase for Joe's hands-on check, with two devices on one
> page.

## Status

- **Effort:** M.
- **Risk:** MEDIUM: drawing other people's carets inside the editor while text changes under
  them.
- **Progress:** TODO, waiting on Agents 001.

## What happens after Agents 001

- The presence contract already carries an exact range: `{ source: Hash, anchor, head }` in
  UTF-8 bytes of a named source object. Nothing on the wire or the host changes here.
- Story already sends the exact caret within the editing block (Agents 001, from Quagmire's
  `EditorState.textSelection`), so this plan only draws.
- Peers are drawn as a block mark (or as header text, if Quagmire couldn't decorate blocks).
- The agent runner already knows the exact range an agent edited (it hashes the new file and
  finds the replaced bytes) and the lines it read, but sends them only as block ranges'
  worth of precision on screen.

## Phase 1: Quagmire draws exact ranges

- The editor draws remote carets and selections given ranges, colours and a label: a thin
  caret with a small name flag, and a translucent selection, inside a block's text. An
  agent's caret carries the agent mark, and its floating bubble attaches to the caret
  instead of the block.
- Quagmire reports a selection that spans blocks, which Agents 001 sends as the selected
  blocks' range.
- A range in another version of the source is drawn fainter (decision 5 of Agents 001).

**Verification:** Quagmire tests for drawing at a range across block kinds (headings, lists,
toggles, task blocks) and after local edits shift it.

## Phase 2: Story draws them

- Story passes each peer's range to the editor; the agent runner sends the exact edited range
  and a read as the exact lines read.
- `docs/implementing-editors/design.md` updated.

**Verification:** by hand with Joe: two devices typing in one paragraph; a selection across
blocks; an agent editing within a long paragraph.

## Open questions

1. **Re-anchoring across versions** (from Live 001). If byte offsets into another version
   prove too rough once carets are exact, a selection could carry a short quote around `head`
   (as in W3C Web Annotation's `TextQuoteSelector`), about 60 bytes more per update.
2. **POST overhead** (from Live 001). Each cursor update is a request carrying the bearer
   token. At block level that didn't matter; at caret level it might. Check what Railway and
   Caddy negotiate with `URLSession` (HTTP/2 header compression), and consider a WebSocket if
   it proves costly.

## Close out

Record it in `status.md` and delete this plan.
