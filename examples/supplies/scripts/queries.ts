import { arbor, query } from "arbor/data"

const arbor_profiles = arbor("../data/arbor_profiles").children
const lists = arbor("../data/lists").children
const profileCard = arbor_profiles.pick("id", "name", "handle", "portrait")

// This query is shared by MyLists and the membership control on Practice.
// Single-consumer handles live beside their component or document instead.
export const myLists = query.many(
  lists,
  (list, { user }) => ({
    where: list.owner_profile.eq(user.required.profile),
    orderBy: list.updated_at.desc(),
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
      practiceMemberships: list.items({
        orderBy: item => item.position,
        select: item => ({ practice_id: item.practice_id }),
      }),
    },
  }),
)
