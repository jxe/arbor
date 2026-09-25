import { useQuery } from "overstory/react"
import { node, query } from "overstory/data"
import { ListGrid } from "./shared"

const arbor_profiles = node("../data/arbor_profiles").children
const lists = node("../data/lists").children
const profileCard = arbor_profiles.pick("id", "name", "handle", "portrait")

export const popularLists = query.many(
  lists,
  list => ({
    where: list.visibility.eq("public"),
    orderBy: list.reactions.count.desc(),
    take: 12,
    select: {
      ...list.pick("id", "name", "about", "visibility", "kind"),
      ownerProfile: list.owner_profile,
      owner: list.owner(profileCard),
      practiceCount: list.items.count,
      reactionCount: list.reactions.count,
      reactionProfiles: list.reactions({
        orderBy: reaction => reaction.profile,
        select: reaction => ({ profile: reaction.profile }),
      }),
    },
  }),
)

export function PopularLists() {
  const lists = useQuery(popularLists)
  return <ListGrid lists={lists} />
}
