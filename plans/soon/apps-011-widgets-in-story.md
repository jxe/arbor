# Apps 011: Widgets in Story

**Order:** after [Apps 005](../../status.md#views-on-the-host-and-declared-views--2026-11-08). Joe's own widgets can be
built and tried while [Apps 010](../later/apps-010-activation-and-lending.md) lands. Widgets from
other people wait for Apps 010.

**Why and when:** Joe wants to embed small apps in Story pages, written in TypeScript with
TSX and drawn natively, not in a web view and not with React (Joe, 2026-11-05, in the apps
discussion). This is the third of the three apps plans Joe split on 2026-11-06. It absorbs
Apps 001 (the Supplies site) and Apps 003 (compiler and editor tooling). Those deleted plans
are in git history, and the parts that still apply are below.

The design and its open questions are in the Claude Doc "Story widgets" from the apps
discussion. Where it says *query* or *endpoint*, read *view*
([Apps 005](../../status.md#views-on-the-host-and-declared-views--2026-11-08)).

## What Joe decided

- **A widget is an addressable view** (`view(Schema, fn)`) that returns a view tree, plus
  the mutations it names as actions.
  - Story runs the JS on the device: Sucrase compiles TSX, and JavaScriptCore runs it.
  - A SwiftUI renderer draws the `{type, props, children, key}` tree.
  - There's no web view per widget and no React. ScriptWidget (MIT) is a reference for the
    SwiftUI mapping.
- **Embedding is a lone link** to a `.tsx` file on its own line in a page.
- **State has an owner, and every kind is ordinary collection data:**

  | Owner | Kind of state |
  |---|---|
  | App | The app's data, read by views |
  | Page | Configuration, as `page model X (placement)`, read with `await setup(X)` and edited in a settings sheet |
  | Reader | Personal data, as `personal model X (placement\|widget\|())`, read with `await mine(Model)` |

  An app reads and writes only its own personal models, with no prompt, written locally
  first.
- **A placement is identified by** the page's TreeID and frontmatter `id`, plus an embed
  key made of the target, its props and which occurrence it is. An explicit key is needed
  only when those aren't enough.
- **Named controls own transient state.** A widget reads it through a `{ fields }`
  argument. `keep` on a control persists its value as personal data, keyed by placement
  and name.
- **Link props only address records** (which list, which practice).
- **Actions are data.** Calling a mutation without `await` gives an action value for
  `Button action=` and `Form action=`. `handle.with({…})` adds input, and
  `.then(result => link)` navigates.
- **Row actions come from mutations.** `mutation.for(Model, "delete"|"move"|"edit"|"create")`
  lets any list of that model offer them. Without one, a list falls back to plain row edits
  through `POST /updates` when the reader can write.
- **No arrangement model in the first cut** (Joe, 2026-11-06). A widget lays out its rows
  in code. A reader's choice of sort or grouping is a `keep` control (a picker) that the
  view reads, kept in personal data per placement. A layout shared by everyone reading a
  page is dropped for now; if it matters, it comes back as a `page model` the view reads.
- **Views run locally on a placed tree when they can,** and on the host otherwise.
- **The UI language becomes its own package, like USL:**
  - The component model and vocabulary.
  - The wire form.
  - The host interface.
  - Conformance fixtures.

  Swift is one implementation, and an HTML renderer is another.

## 1. The UI language package

- Split the JSX runtime out of apps-runtime, with:
  - The view tree types.
  - The vocabulary of the 26 components listed in the design doc.
  - Their props and events.
  - Conformance fixtures, each a view tree with the expected rendering facts.
- **Decide first:** the package's name and where its spec lives (proposed:
  `docs/ui-language/`).

## 2. Running a widget in Story

- Story compiles a widget's `.tsx` and its imports with Sucrase, at the pinned version of
  its tree.
- It runs the widget in JavaScriptCore against a host interface for views, mutations,
  `mine`, `setup` and navigation.
- **Re-runs work like this:**
  - Reads are keyed by view and input.
  - There's at most one run per frame, and generation numbers drop stale runs.
  - The old tree stays on screen until the new run is ready.
  - Story waits up to about 100 ms so all of a run's streams are at one tree version.
- Views on a placed tree are planned and run against Story Sync's local SQLite. Otherwise
  Story asks the host for the view's `rows` answer
  ([executable documents §12.1](../../docs/overstory-spec/4.1-executable-documents.md#121-evaluate-and-stream-views))
  and runs the view itself, so state changes stay on the device.

## 3. The SwiftUI renderer

- Draw the vocabulary on the Mac and on the iPhone.
- Controls bind to named fields. Actions run mutations and show pending and error states.
- Lists of a model offer its row actions.
- Snapshot-test the conformance fixtures on both platforms.

## 4. Embedding, placement and state

- A lone `.tsx` link on a page draws the widget in place, with a menu for its settings.
- Placement identity, `page model` with `setup()`, `personal model` with `mine()`, and
  `keep`, as decided above.
- Personal rows live under the reader's own tree and sync like any collection.
- Port Supplies' List, Practice and search screens as widgets. They are the acceptance
  corpus.

## 5. Checking and editor tooling (from Apps 003)

- `story check <tree-or-path>` typechecks widgets and views against their trees' schemas:
  - Row types come from USL.
  - Narrowing callbacks get the SQL-only row type.
  - Diagnostics point at source spans.
- Later, one language service for VS Code and Zed over the same checker, with completion
  for tables, fields and mutation handles.

## Later: the HTML renderer and the Supplies site (from Apps 001)

A second renderer draws the same view trees as HTML, so a tree's widgets also work as a web
site, served by overstoryd and later from a host such as Vercel.
- The rules carry over from Apps 001:
  - Pages advertise their source with `<link rel="overstory">`.
  - Bundles hold no server code or credentials.
  - The browser never receives raw SQLite or unrelated private rows.
- If the Supplies site ever moves off its current home, migrating its real data needs a
  reviewed identity map, durable redirects, side-by-side staging and a tested rollback.

## Code to bring in line with the spec (Joe, 2026-11-11)

The spec now addresses views by file path with the extension
([executable documents §1](../../docs/overstory-spec/4.1-executable-documents.md#1-views-and-their-addresses)):
a file's default `view` export is its one linkable view, and the same spelling is used to
import, embed, link and `GET` it. `.mdx` is gone, and the React document model
(`overstory/react`, `useQuery`, extensionless `.tsx` routing) is gone from
[the authoring API](../../docs/overstory-spec/4.1-executable-documents.md#16-authoring-api). Still to do in code:

- `.mdx` files are plain file entries, not pages: `packages/protocol/src/pages.ts`,
  `path-read.ts` (`x.mdx`, `_index.mdx`), Swift `ProtocolPage.swift` and `ProtocolPathRead.swift`,
  and the `pages.json` conformance vectors. A tree holding a `.mdx` page changes it at the
  Protocol 003 flag day.
- Supplies: `Home.mdx` becomes `Home.md` with embeds; the old React `List.tsx`, `Practice.tsx`,
  `Profile.tsx`, `MyLists.tsx` give way to `views/*.tsx`.
- A view embedded with no query string receives its page's query string.

## Verify

- Each step has tests on the TypeScript side.
- Swift snapshot tests cover the renderer.
- When a step lands, its hand check of the Supplies widgets on Joe's Mac and iPhone goes to
  [Joe's to-do](../joe.md).

Never widen authority to get a widget working: until Apps 010, widgets run as their reader,
and only Joe's own are enabled.
