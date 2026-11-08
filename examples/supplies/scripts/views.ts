// The rows Supplies' views read, the sources they read them from, and what several views
// share. Views read rows directly (executable documents §4.1): facts narrow, relationship
// reads follow, and ordering is plain JS except where a limit needs it.
import { node, or, rule, view, QueryUserRequiredError, type Key, type Rows, type Source } from "overstory/data"

export interface PersonRow {
  id: Key<"Person">
  name: string
  handle: string
  portrait: string | null
  bio: string | null
  practices: Rows<PracticeRow>
  ownedLists: Rows<ListRow>
  reactions: Rows<ReactionRow>
  contributions: Rows<ContributionRow>
}

export interface ListRow {
  id: Key<"List">
  name: string
  about: string | null
  visibility: "Public" | "Private"
  kind: "Standard" | "Tagged"
  openToEdits: boolean
  owner: PersonRow
  items: Rows<ItemRow>
  tags: Rows<TagRow>
  reactions: Rows<ReactionRow>
  contributors: Rows<ContributionRow>
  created: string
  modified: string
}

export interface PracticeRow {
  id: Key<"Practice">
  name: string
  about: string | null
  authors: Rows<PersonRow>
  items: Rows<ItemRow>
  tags: Rows<TagRow>
}

export interface ItemRow {
  list: ListRow
  practice: PracticeRow
  items_position: number
}

export interface TagRow {
  list: ListRow
  id: string
  name: string
  color: string | null
  practices: Rows<PracticeRow>
}

export interface ReactionRow {
  list: ListRow
  person: PersonRow
  emoji: string
}

export interface ContributionRow {
  list: ListRow
  person: PersonRow
  first: string
  last: string
}

export const List: Source<ListRow> = node("../data/List").children as any
export const Practice: Source<PracticeRow> = node("../data/Practice").children as any
export const Person: Source<PersonRow> = node("../data/Person").children as any

/**
 * Who may see a list: public lists, and your own. An app rule each view applies, until read
 * rules can test a value (access policy, Schema language 010); it isn't a security boundary.
 */
export const visible = rule<{ l: any; me: string | null }>(({ l, me }) => [
  or([l.visibility.is("Public")], [l.owner.is(me)]),
])

export const card = (person: PersonRow) => ({
  id: person.id,
  name: person.name,
  handle: person.handle,
  portrait: person.portrait,
})

export const sorted = <T,>(rows: readonly T[], compare: (left: T, right: T) => number): T[] => [...rows].sort(compare)
export const byText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)
export const byName = (left: { name: string; id?: string }, right: { name: string; id?: string }) =>
  byText(left.name, right.name) || byText(String(left.id ?? ""), String(right.id ?? ""))

/** A list as list cards show it. */
export const listSummary = (l: ListRow) => ({
  id: l.id,
  name: l.name,
  about: l.about,
  visibility: l.visibility,
  kind: l.kind,
  ownerProfile: l.owner.id,
  owner: card(l.owner),
  practiceCount: l.items.length,
  reactionCount: l.reactions.length,
  reactionProfiles: sorted(l.reactions, (left, right) => byText(left.person.id, right.person.id))
    .map(reaction => ({ profile: reaction.person.id })),
})

// Shared by MyLists and the membership control on Practice. Single-consumer views live
// beside their component or document.
export const myLists = view((_input, { user }) => {
  if (!user) throw new QueryUserRequiredError()
  const mine = List.all(l => [l.owner.is(user.profile)])
  return sorted(mine, (left, right) => byText(right.modified, left.modified) || byText(left.id, right.id)).map(l => ({
    ...listSummary(l),
    practiceMemberships: sorted(l.items, (left, right) => left.items_position - right.items_position || byText(left.practice.id, right.practice.id))
      .map(item => ({ practice: item.practice.id })),
  }))
})
