/** @jsxImportSource overstory/ui */
// The Practice page: a practice, and (a second root) the visible lists it is on.
import { endpoint } from "overstory/endpoint"
import { z } from "zod"
import { Attribution, card, practices, visibleLists } from "./shared"
import { Column, Link, Markdown, Row, Text } from "./ui"

const PracticeID = z.object({ id: z.string().uuid() })

const listsWith = (id: string, user: { profile: string } | null) =>
  (body: (lists: any) => any) => visibleLists(user).many({
    where: l => l.items.some(item => item.practice.eq(id)),
    orderBy: l => l.reactions.count.desc(),
  }, body)

export const practiceData = endpoint(PracticeID, ({ id }, { user }) =>
  practices.maybe({ id }, p => p && ({
    id: p.id,
    name: p.name,
    about: p.about,
    authors: p.authors.orderBy(a => a.name).map(card),
    lists: listsWith(id, user)(lists => lists.map(l => ({
      id: l.id,
      name: l.name,
      owner: card(l.owner),
      practices: l.items.length,
      reactions: l.reactions.length,
    }))),
  })))

export const PracticePage = endpoint(PracticeID, ({ id }, { user }) =>
  practices.maybe({ id }, p => p
    ? (
      <Column>
        <Text style="title">{p.name}</Text>
        <Attribution people={p.authors.orderBy(a => a.name)} intro="by" />
        <Markdown source={p.about ?? ""} />
        <Text style="heading">On these lists</Text>
        {listsWith(id, user)(lists => lists.length
          ? lists.map(l => (
            <Row key={l.id}>
              <Link href={`List?id=${l.id}`}>{l.name}</Link>
              <Text style="secondary">{l.items.length} practices · 👍 {l.reactions.length}</Text>
            </Row>
          ))
          : <Text>Not on any list you can see.</Text>)}
      </Column>
    )
    : <Text>No such practice.</Text>))
