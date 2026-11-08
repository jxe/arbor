import { useState } from "react"
import { skipQuery, useQuery } from "overstory/react"
import { view } from "overstory/data"
import { byName, card, Practice, sorted } from "../scripts/views"
import { z } from "zod"
import { PracticeGrid, TextInput } from "./shared"


export const practiceSearch = view(z.object({ search: z.string() }), ({ search }) =>
  Practice.all(p => [p.name.contains(search)])
    .orderBy(p => p.name)
    .take(24)
    .map(p => ({
      id: p.id,
      name: p.name,
      about: p.about,
      authors: sorted(p.authors, byName).map(card),
    })))

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
