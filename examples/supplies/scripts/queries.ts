import { node, query } from "overstory/data"

const people = node("../data/Person").children
const lists = node("../data/List").children
const profileCard = people.pick("id", "name", "handle", "portrait")

// This query is shared by MyLists and the membership control on Practice.
// Single-consumer handles live beside their component or document instead.
export const myLists = query.many(
  lists,
  (list, { user }) => ({
    where: list.owner.eq(user.required.profile),
    orderBy: list.modified.desc(),
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
      practiceMemberships: list.items({
        orderBy: item => item.items_position,
        select: item => ({ practice: item.practice }),
      }),
    },
  }),
)
