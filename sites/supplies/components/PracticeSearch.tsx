import { useState } from "react"
import { skipQuery, useQuery } from "arbor/react"
import { database, query, rel } from "arbor/data"
import { z } from "zod"
import { PracticeGrid, TextInput } from "./shared"

const suppliesData = database("../data")

export const practiceSearch = query(
  suppliesData,
  z.object({ search: z.string() }),
  rel`
    p: practices() where p.name contains $search
    pa: practice_authors(practice_id: p.id)
    author: arbor_profiles(id: pa.author_profile)

    return many p
      key by id
      order by name, id
      first 24 {
        id
        name
        about
        authors: many author key by id order by name, id {
          id
          name
          handle
          portrait
        }
      }
  `,
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
