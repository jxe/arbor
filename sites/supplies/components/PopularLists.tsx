import { useQuery } from "arbor/react"
import { database, query, rel } from "arbor/data"
import { z } from "zod"
import { ListGrid } from "./shared"

const suppliesData = database("../data")

export const popularLists = query(
  suppliesData,
  z.object({}),
  rel`
    l: lists(visibility: "public")
    lp: list_practices(list_id: l.id)
    lr: list_reactions(list_id: l.id)
    owner: arbor_profiles(id: l.owner_profile)

    return many l
      key by id
      order by count(lr) desc, id
      first 12 {
        id
        name
        about
        visibility
        kind
        ownerProfile: owner_profile
        owner: one owner { id name handle portrait }
        practiceCount: count(lp)
        reactionCount: count(lr)
        reactionProfiles: many lr key by profile order by profile { profile }
      }
  `,
)

export function PopularLists() {
  const lists = useQuery(popularLists, {})
  return <ListGrid lists={lists} />
}
