import { useQuery, useUser } from "overstory/react"
import { view } from "overstory/data"
import { z } from "zod"
import { ListGrid, PracticeGrid, Shell } from "./components/shared"
import { byName, listSummary, Person, sorted } from "./scripts/views"


export const profile = view(z.object({ profile: z.string().min(1) }), ({ profile }) => {
  const person = Person.one(p => [p.id.is(profile)])
  return person && {
    id: person.id,
    name: person.name,
    handle: person.handle,
    portrait: person.portrait,
    bio: person.bio,
    practices: sorted(person.practices, byName).map(p => ({ id: p.id, name: p.name, about: p.about })),
    lists: sorted(person.ownedLists.all(l => [l.visibility.is("Public")]), byName).map(listSummary),
  }
})

export default function ProfilePage({ search }: { search: URLSearchParams }) {
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
        <p>This Story profile is unavailable.</p>
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
