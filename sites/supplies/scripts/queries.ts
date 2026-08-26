import { database, query, rel } from "arbor/data"
import { z } from "zod"

const suppliesData = database("../data")

// This query is shared by MyLists and the membership control on Practice.
// Single-consumer handles live beside their component or document instead.
export const myLists = query(
  suppliesData,
  z.object({}),
  rel`
    require user

    l: lists(owner_profile: user.profile)
    owner: arbor_profiles(id: l.owner_profile)
    lp: list_practices(list_id: l.id)
    lr: list_reactions(list_id: l.id)

    return many l key by id order by updated_at desc, id {
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
      practiceMemberships: many lp key by practice_id order by position, practice_id {
        practice_id
      }
    }
  `,
)
