import { useQuery, useUser } from "arbor/react"
import { database, query } from "arbor/data"
import { z } from "zod"
import { ListGrid, PracticeGrid, Shell } from "./components/shared"

const suppliesData = database("./data")
const { arbor_profiles } = suppliesData.relations
const profileCard = arbor_profiles.pick("id", "name", "handle", "portrait")

export const profile = query.maybe(
  arbor_profiles,
  z.object({ profile: z.string().min(1) }),
  (person, { input }) => ({
    where: person.id.eq(input.profile),
    select: {
      ...person.pick("id", "name", "handle", "portrait", "bio"),
      practices: person.practices({
        orderBy: practice => practice.name,
        select: practice => practice.pick("id", "name", "about"),
      }),
      lists: person.lists({
        where: list => list.visibility.eq("public"),
        orderBy: list => list.name,
        select: list => ({
          ...list.pick("id", "name", "about", "visibility", "kind"),
          ownerProfile: list.owner_profile,
          owner: list.owner(profileCard),
          practiceCount: list.items.count,
          reactionCount: list.reactions.count,
          reactionProfiles: list.reactions({
            orderBy: reaction => reaction.profile,
            select: reaction => ({ profile: reaction.profile }),
          }),
        }),
      }),
    },
  }),
)

export default function Profile({ search }: { search: URLSearchParams }) {
  const id = search.get("id")
  if (!id) {
    return (
      <Shell title="Profile unavailable">
        <title>Profile unavailable</title>
        <p>This link has no profile ID.</p>
      </Shell>
    )
  }
  return <ProfileContent id={id} />
}

function ProfileContent({ id }: { id: string }) {
  const person = useQuery(profile, { profile: id })
  const user = useUser()
  if (!person) {
    return (
      <Shell title="Profile not found">
        <title>Profile unavailable</title>
        <p>This Arbor profile is unavailable.</p>
      </Shell>
    )
  }
  const isUser = user?.profile === person.id
  return (
    <Shell
      title={person.name}
      subtitle={<><span>@{person.handle}</span>{person.bio ? <p>{person.bio}</p> : null}</>}
    >
      <title>{person.name} — Meaning Supplies</title>
      <meta name="description" content={person.bio || "Practices and lists on Meaning Supplies"} />
      <section className="mt-10">
        <h2 className="mb-3 text-xl font-semibold">{isUser ? "Practices you made" : `Practices ${person.name} made`}</h2>
        <PracticeGrid practices={person.practices} />
      </section>
      <section className="mt-10">
        <h2 className="mb-3 text-xl font-semibold">{isUser ? "Lists you curated" : `Lists ${person.name} curated`}</h2>
        <ListGrid lists={person.lists} />
      </section>
    </Shell>
  )
}
