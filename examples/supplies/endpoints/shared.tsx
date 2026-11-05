/** @jsxImportSource overstory/ui */
// Fragments are plain functions over rows. Whatever they read joins the caller's plan.
import { node } from "overstory/data"
import { table } from "overstory/endpoint"
import { Badge, Link, Row, Text } from "./ui"

export const lists = table(node("../data/List").children)
export const practices = table(node("../data/Practice").children)

/** Lists a caller may see. Who may see a list is narrowing, so a private list never leaves the host. */
export const visibleLists = (user: { profile: string } | null) =>
  lists.where(l => l.visibility.eq("Public").or(l.owner.eq(user?.profile ?? null)))

export const card = (person: any) => ({
  id: person.id,
  name: person.name,
  handle: person.handle,
  portrait: person.portrait,
})

export const byName = (left: { name: string }, right: { name: string }) => left.name.localeCompare(right.name)

export function Attribution({ people, intro }: { people: any[]; intro: string }) {
  return (
    <Row>
      <Text style="secondary">{intro}</Text>
      {people.map(person => <Link key={person.id} href={`Profile?id=${person.id}`}>{person.name}</Link>)}
    </Row>
  )
}

export function Tags({ tags }: { tags: any[] }) {
  return <Row>{tags.map(tag => <Badge key={tag.id} color={tag.color ?? undefined}>{tag.name}</Badge>)}</Row>
}
