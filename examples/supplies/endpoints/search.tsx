/** @jsxImportSource overstory/ui */
// Practice search: input narrows on the host, trimming runs in plain JS first.
import { endpoint } from "overstory/endpoint"
import { z } from "zod"
import { Attribution, card, practices } from "./shared"
import { Column, Grid, Link, Text } from "./ui"

const Search = z.object({ search: z.string() })

const matching = (search: string) => (body: (rows: any) => any) =>
  practices.many({ where: p => p.name.contains(search), orderBy: p => p.name, take: 24 }, body)

export const practiceSearchData = endpoint(Search, ({ search }) => {
  const q = search.trim()
  if (!q) return []
  return matching(q)(found => found.map(p => ({
    id: p.id,
    name: p.name,
    about: p.about,
    authors: p.authors.orderBy(a => a.name).map(card),
  })))
})

export const PracticeSearch = endpoint(Search, ({ search }) => {
  const q = search.trim()
  if (!q) return null
  return matching(q)(found => (
    <Column>
      <Text style="heading">Matching practices</Text>
      {found.length
        ? <Grid>{found.map(p => (
          <Column key={p.id}>
            <Link href={`Practice?id=${p.id}`}>{p.name}</Link>
            <Attribution people={p.authors.orderBy(a => a.name)} intro="by" />
          </Column>
        ))}</Grid>
        : <Text>No practices found.</Text>}
    </Column>
  ))
})
