import { useState } from "react"
import { skipQuery, useQuery } from "arbor/react"
import { arbor, query } from "arbor/data"
import { z } from "zod"
import { PracticeGrid, TextInput } from "./shared"

const arbor_profiles = arbor("../data/arbor_profiles").children
const practices = arbor("../data/practices").children
const profileCard = arbor_profiles.pick("id", "name", "handle", "portrait")

export const practiceSearch = query.many(
  practices,
  z.object({ search: z.string() }),
  (practice, { input }) => ({
    where: practice.name.contains(input.search),
    orderBy: practice.name,
    take: 24,
    select: {
      ...practice.pick("id", "name", "about"),
      authors: practice.authors({
        orderBy: author => author.name,
        select: profileCard,
      }),
    },
  }),
)

export function PracticeSearch() {
  const [search, setSearch] = useState("")
  const normalized = search.trim()
  const practices = useQuery(practiceSearch, normalized ? { search: normalized } : skipQuery)

  return (
    <div>
      <label className="mx-auto mb-10 grid max-w-md gap-2">
        <span className="text-sm font-semibold text-slate-600">Find a practice</span>
        <TextInput
          className="text-lg"
          type="search"
          value={search}
          onChange={event => setSearch(event.target.value)}
          placeholder="Type a practice name…"
        />
      </label>

      {normalized ? (
        <section className="mt-10">
          <h2 className="mb-3 text-xl font-semibold">Matching practices</h2>
          {practices.length ? <PracticeGrid practices={practices} /> : <p>No practices found.</p>}
        </section>
      ) : null}
    </div>
  )
}
