import { useQuery } from "overstory/react"
import { node, query } from "overstory/data"
import { ListGrid } from "./shared"

const people = node("../data/Person").children
const lists = node("../data/List").children
const profileCard = people.pick("id", "name", "handle", "portrait")

export const popularLists = query.many(
  lists,
  list => ({
    where: list.visibility.eq("Public"),
    orderBy: list.reactions.count.desc(),
    take: 12,
    select: {
      ...list.pick("id", "name", "about", "visibility", "kind"),
      ownerProfile: list.owner,
      owner: list.owner(profileCard),
      practiceCount: list.items.count,
      reactionCount: list.reactions.count,
      reactionProfiles: list.reactions({
        orderBy: reaction => reaction.person,
        select: reaction => ({ profile: reaction.person }),
      }),
    },
  }),
)

export function PopularLists() {
  const lists = useQuery(popularLists)
  return <ListGrid lists={lists} />
}
