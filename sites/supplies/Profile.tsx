import { useQuery, useUser } from "arbor/react"
import { database, query, rel } from "arbor/data"
import { z } from "zod"
import { ListGrid, PracticeGrid, Shell } from "./components/shared"

const suppliesData = database("./data")

export const profile = query(
  suppliesData,
  z.object({ profile: z.string().min(1) }),
  rel`
    person: arbor_profiles(id: $profile)
    pa: practice_authors(author_profile: person.id)
    p: practices(id: pa.practice_id)
    l: lists(owner_profile: person.id, visibility: "public")
    lp: list_practices(list_id: l.id)
    lr: list_reactions(list_id: l.id)

    return nullable one person {
      id
      name
      handle
      portrait
      bio
      practices: many p key by id order by name, id {
        id name about
      }
      lists: many l key by id order by name, id {
        id
        name
        about
        visibility
        kind
        ownerProfile: owner_profile
        owner: one person { id name handle portrait }
        practiceCount: count(lp)
        reactionCount: count(lr)
        reactionProfiles: many lr key by profile order by profile { profile }
      }
    }
  `,
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
