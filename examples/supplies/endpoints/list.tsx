/** @jsxImportSource overstory/ui */
// The List page as two endpoints: one answers JSON, one answers a view.
import { endpoint } from "overstory/endpoint"
import { z } from "zod"
import { Attribution, byName, card, Tags, visibleLists } from "./shared"
import { Button, Column, Grid, Link, Markdown, Text } from "./ui"

const ListID = z.object({ id: z.string().uuid() })

export const listData = endpoint(ListID, ({ id }, { user }) =>
  visibleLists(user).maybe({ id }, l => l && ({
    id: l.id,
    name: l.name,
    about: l.about,
    visibility: l.visibility,
    kind: l.kind,
    openToEdits: l.openToEdits,
    owner: card(l.owner),
    contributors: l.contributors
      .map(contribution => card(contribution.person))
      .filter(person => person.id !== l.owner.id)
      .sort(byName),
    items: l.items.orderBy(item => item.items_position).map(item => ({
      practice: {
        id: item.practice.id,
        name: item.practice.name,
        about: item.practice.about,
        authors: item.practice.authors.orderBy(author => author.name).map(card),
        tags: item.practice.tags
          .where(tag => tag.list.eq(id))
          .orderBy(tag => tag.name)
          .map(tag => ({ id: tag.id, name: tag.name, color: tag.color })),
      },
    })),
    reactions: l.reactions.length,
    reacted: l.reactions.some(reaction => reaction.person.id === user?.profile),
    tags: l.tags.orderBy(tag => tag.name).map(tag => ({ id: tag.id, name: tag.name, color: tag.color })),
  })))

export const ListPage = endpoint(ListID, ({ id }, { user }) =>
  visibleLists(user).maybe({ id }, l => {
    if (!l) return <Text>This list does not exist or is not visible to you.</Text>
    const canEdit = Boolean(user && (l.owner.id === user.profile || l.openToEdits))
    const others = l.contributors.map(c => c.person).filter(p => p.id !== l.owner.id).sort(byName)
    return (
      <Column>
        <Text style="title">{l.name}</Text>
        <Attribution people={[l.owner, ...others]} intro="a list by" />
        {l.visibility === "Private" ? <Text style="secondary">Private</Text> : null}
        {l.about ? <Markdown source={l.about} /> : null}
        {canEdit ? <Link href={`List?id=${id}&edit`}>Edit</Link> : null}
        <Button action={{ mutation: "toggleListReaction", input: { listId: id } }}>
          👍 {l.reactions.length}
        </Button>
        <Grid>
          {l.items.orderBy(item => item.items_position).map(item => (
            <Column key={item.practice.id}>
              <Link style="heading" href={`Practice?id=${item.practice.id}`}>{item.practice.name}</Link>
              <Attribution people={item.practice.authors.orderBy(a => a.name)} intro="by" />
              <Markdown source={item.practice.about ?? ""} lines={6} />
              {l.kind === "Tagged"
                ? <Tags tags={item.practice.tags.where(tag => tag.list.eq(id)).orderBy(tag => tag.name)} />
                : null}
            </Column>
          ))}
        </Grid>
      </Column>
    )
  }))
