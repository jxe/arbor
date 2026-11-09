/** @jsxImportSource overstory/ui */
// The List page as a JSX view: the same reads as the `list` data view, drawn.
import { view } from "overstory/data"
import { z } from "zod"
import { byName, byText, List, Practice, sorted, visible, type ListRow, type PersonRow, type TagRow } from "../scripts/views"
import { Badge, Button, Column, Grid, Link, Markdown, Row, Text } from "./ui"

export function Attribution({ people, intro }: { people: PersonRow[]; intro: string }) {
  return (
    <Row>
      <Text style="secondary">{intro}</Text>
      {people.map(person => <Link key={person.id} href={`Profile?id=${person.id}`}>{person.name}</Link>)}
    </Row>
  )
}

function Tags({ tags }: { tags: TagRow[] }) {
  return <Row>{tags.map(tag => <Badge key={tag.id} color={tag.color ?? undefined}>{tag.name}</Badge>)}</Row>
}

export const ListPage = view(z.object({ id: z.string().uuid() }), ({ id }, { user }) => {
  const me = user?.profile ?? null
  const l: ListRow | null = List.one(l => [l.id.is(id), visible({ l, me })])
  if (!l) return <Text>This list does not exist or is not visible to you.</Text>
  const canEdit = Boolean(me && (l.owner.id === me || l.openToEdits))
  const others = sorted(l.contributors.map(c => c.person).filter(p => p.id !== l.owner.id), byName)
  return (
    <Column>
      <Text style="title">{l.name}</Text>
      <Attribution people={[l.owner, ...others]} intro="a list by" />
      {l.visibility === "Private" ? <Text style="secondary">Private</Text> : null}
      {l.about ? <Markdown source={l.about} /> : null}
      {canEdit ? <Link href={`List?id=${id}&edit`}>Edit</Link> : null}
      {me && l.visibility === "Public"
        ? <Button action={{ mutation: "toggleListReaction", input: { listId: id } }}>👍 {l.reactions.length}</Button>
        : <Text style="secondary">👍 {l.reactions.length}</Text>}
      <Grid>
        {sorted(l.items, (left, right) => left.items_position - right.items_position).map(item => (
          <Column key={item.practice.id}>
            <Link style="heading" href={`Practice?id=${item.practice.id}`}>{item.practice.name}</Link>
            <Attribution people={sorted(item.practice.authors, byName)} intro="by" />
            <Markdown source={item.practice.about ?? ""} lines={6} />
            {l.kind === "Tagged"
              ? <Tags tags={sorted(item.practice.tags.all(t => [t.list.is(l)]), byName)} />
              : null}
          </Column>
        ))}
      </Grid>
    </Column>
  )
})

// Search trims in JS before it narrows, and an empty search reads nothing.
export const PracticeSearch = view(z.object({ search: z.string() }), ({ search }) => {
  const text = search.trim()
  if (!text) return null
  const found = Practice.all(p => [p.name.contains(text)]).orderBy(p => p.name).take(24)
  return (
    <Column>
      <Text style="heading">Matching practices</Text>
      {found.length
        ? <Grid>{found.map(p => (
          <Column key={p.id}>
            <Link href={`Practice?id=${p.id}`}>{p.name}</Link>
            <Attribution people={sorted(p.authors, byName)} intro="by" />
          </Column>
        ))}</Grid>
        : <Text>No practices found.</Text>}
    </Column>
  )
})

// The Practice page: a practice, and (a second root) the lists you can see that include it.
export const PracticePage = view(z.object({ id: z.string().uuid() }), ({ id }, { user }) => {
  const p = Practice.one(p => [p.id.is(id)])
  if (!p) return <Text>No such practice.</Text>
  const lists = sorted(
    List.all(l => [l.items.practice.is(p), visible({ l, me: user?.profile ?? null })]),
    (left, right) => right.reactions.length - left.reactions.length || byText(left.id, right.id),
  )
  return (
    <Column>
      <Text style="title">{p.name}</Text>
      <Attribution people={sorted(p.authors, byName)} intro="by" />
      <Markdown source={p.about ?? ""} />
      <Text style="heading">On these lists</Text>
      {lists.length
        ? lists.map(l => (
          <Row key={l.id}>
            <Link href={`List?id=${l.id}`}>{l.name}</Link>
            <Text style="secondary">{l.items.length} practices · 👍 {l.reactions.length}</Text>
          </Row>
        ))
        : <Text>Not on any list you can see.</Text>}
    </Column>
  )
})
