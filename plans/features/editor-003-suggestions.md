# Editor 003: suggestions, from people and agents

**Timing:** Later, after [Agents 001](agents-001-presence-and-a-first-agent.md). Joe wants
to see how direct edits feel in daily use first.

**Why and when:** Joe asked on 2026-10-30 for edits that arrive as suggestions you accept or
reject, as their own plan covering people and agents alike (thread "Bring AI into Story
smoothly"). He wants two representations, because they mean different things:

- **Inline suggestions, in Markdown.** A suggestion written into the page itself, in
  [CriticMarkup](https://github.com/CriticMarkup/CriticMarkup-toolkit), the existing plain-text
  convention for this. It is a proposal *in the document*: everyone who reads the page sees
  it, it syncs and has history like any text, and accepting it is an ordinary edit. It suits a
  small, local change offered for the page's owner to take or leave.
- **An overlay tree.** Someone makes their own tree that references a parent tree and holds
  only their changes, like a branch in Git. It is a proposal *beside the document*: a whole
  alternative version, possibly across many pages, that its author can keep working on, and
  that is reviewed and merged (or not) as a set. The parent is untouched until then.

> **Executor instructions**: Settle the forks with Joe first; the overlay tree is a sketch
> until then. Refresh against Agents 001, overstoryd 007 and overstoryd 015/016 as built.
> Quagmire changes ship with an arbor release, never alone.

## Status

- **Effort:** M for inline suggestions (part 1). L for overlay trees (part 2), which is a new
  kind of tree.
- **Risk:** LOW for part 1: it is a text format and an editor feature, with no protocol change.
  HIGH for part 2: overlays touch the spec's tree model, merge, access and history.
- **Progress:** TODO, forks open.

## What exists

- **Agents 001** runs the agent in the placed folder, so its edits land directly.
- **Choice review** (overstoryd 015, 016): the host already holds choices, alternatives from
  concurrent edits that wait for a person, with review cards in Story. Merging an overlay back
  into its parent can produce exactly these.
- **The merge engine** already merges concurrent work on one tree from a common basis, which
  is what merging an overlay into its parent needs.
- **Nothing reads CriticMarkup today.** Story's `MarkdownCodec` would show `{++ … ++}` as
  literal text.

## Part 1: inline suggestions in CriticMarkup

CriticMarkup's marks:

```markdown
Buy {++oat ++}milk.            an insertion
Buy {--whole --}milk.          a deletion
Buy {~~whole~>oat~~} milk.     a substitution
{==Buy milk.==}{>>which kind?<<}   a highlight with a comment
```

- **In the editor:** insertions tinted, deletions struck through, substitutions both, each in
  the suggester's colour, with **Accept** and **Reject** on hover or tap. Accepting or
  rejecting rewrites the marked text as plain text: an ordinary edit. **Accept all** and
  **Reject all** per page.
- **Who suggested it.** CriticMarkup has no author field. Recommendation: Story leaves the
  marks plain and attributes them through line provenance (who wrote that line), rather than
  adding a nonstandard author syntax. Fork 3.
- **Making them:** a **Suggest edits** mode per page, in which typing writes CriticMarkup
  instead of changing the text. Turning it off leaves the suggestions in place.
- **Agents:** a task block or a default says "suggest". The skill then tells the agent to
  write its changes as CriticMarkup rather than editing the text directly. That needs nothing
  from the runner but a line in the prompt, which makes it the cheapest way for an agent to
  suggest.
- **Elsewhere:** other tools see readable plain text with marks, and CriticMarkup-aware
  editors show them as changes.

**Phases:** Quagmire inline marks for the three edit kinds plus highlight and comment, and
the codec reading and writing them byte-for-byte. Then Accept and Reject. Then Suggest edits
mode. Then the agent's "suggest" setting. Each phase gets round-trip tests and a hand check
with Joe.

## Part 2: overlay trees

A sketch for the forks below.

- An overlay is a tree of its own whose configuration names a parent tree and a basis: the
  parent's root it started from. It stores only what differs. Reading the overlay shows the
  parent at its basis with the overlay's changes on top.
- Its author places it and edits it like any tree, in Story or with an agent. An agent run set
  to "branch" could make an overlay and work there.
- **Catching up** moves the basis to the parent's newer root, merging as the host merges
  concurrent work; conflicts become choices in the overlay.
- **Proposing** shows the parent's owner the overlay's changes against the parent, page by
  page. **Merging** applies them to the parent as ordinary updates (attributed to the overlay's
  author, Agents 003), with conflicts going through choice review. Merging part of an overlay
  is fork 5.
- Access: an overlay's readers need read access to the parent too; it never widens what anyone
  can see of the parent.

## Forks for Joe

1. **Overlay storage.** Store only the differences (light, but every read composes two trees),
   or start as a full copy that remembers its parent and basis (simple reads, heavier to make).
   Recommendation: a full copy first, since the merge engine already merges from a basis.
2. **Overlays across hosts.** Must an overlay live on the parent's host? Recommendation: yes
   at first.
3. **Authorship in CriticMarkup.** Line provenance only (recommended), or an author mark such
   as `{>>@joe<<}` after each suggestion, as some CriticMarkup tools do.
4. **Who may suggest.** In CriticMarkup a suggestion is an edit, so only writers can make one.
   Should readers be able to suggest? That would mean an access level that may write only
   CriticMarkup, or an overlay of their own (which needs only read access to the parent).
5. **Merging part of an overlay.** All or nothing, per page, or per change?

## Close out

Record each part in `status.md` as it lands, and delete this plan.
