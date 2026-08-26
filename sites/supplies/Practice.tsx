import { Markdown, useMutationAction, useQuery, useUser } from "arbor/react"
import { database, mutation, publicError, query, rel } from "arbor/data"
import { z } from "zod"
import { setListPractice } from "./scripts/mutations"
import { myLists } from "./scripts/queries"
import {
  Attribution,
  Button,
  ButtonLink,
  ListGrid,
  MutationError,
  Panel,
  Shell,
  TextArea,
  TextInput,
} from "./components/shared"

const suppliesData = database("./data")
const { practice_authors, practices } = suppliesData.relations

export const practice = query(
  suppliesData,
  z.object({ id: z.string().uuid() }),
  rel`
    p: practices(id: $id)
    pa: practice_authors(practice_id: p.id)
    author: arbor_profiles(id: pa.author_profile)
    lp: list_practices(practice_id: p.id)
    l: lists(id: lp.list_id)
    owner: arbor_profiles(id: l.owner_profile)
    lr: list_reactions(list_id: l.id)
    all_lp: list_practices(list_id: l.id)

    where l.visibility == "public" or l.owner_profile == user.profile

    return nullable one p {
      id
      name
      about
      authors: many author key by id order by name, id {
        id name handle portrait
      }
      lists: many l key by id order by count(lr) desc, id {
        id
        name
        about
        visibility
        kind
        ownerProfile: owner_profile
        owner: one owner { id name handle portrait }
        practiceCount: count(all_lp)
        reactionCount: count(lr)
        reactionProfiles: many lr key by profile order by profile { profile }
      }
    }
  `,
)

export const updatePractice = mutation(
  suppliesData,
  z.object({
    practiceId: z.string().uuid(),
    name: z.string().trim().min(1),
    about: z.string().trim().min(1),
  }),
  async ({ user, tx, now }, input) => {
    if (!user) throw publicError("user-required", "This operation requires an Arbor user")
    const authors = await tx.many(practice_authors, { practice_id: input.practiceId })
    if (authors.length > 0 && !authors.some(row => row.author_profile === user.profile)) {
      throw publicError("permission-denied", "Only an author can edit this practice")
    }
    await tx.update(practices, { id: input.practiceId }, {
      name: input.name,
      about: input.about,
      updated_at: now,
    })
    return { ok: true }
  },
)

export default function Practice({ search }: { search: URLSearchParams }) {
  const id = search.get("id")
  if (!id) {
    return (
      <Shell title="Practice unavailable">
        <title>Practice unavailable</title>
        <p>This link has no practice ID.</p>
      </Shell>
    )
  }
  return <PracticeContent id={id} editing={search.has("edit")} />
}

function PracticeContent({ id, editing = false }: { id: string; editing?: boolean }) {
  const value = useQuery(practice, { id })
  const user = useUser()
  if (!value) {
    return (
      <Shell title="Practice not found">
        <title>Practice unavailable</title>
        <p>This practice is unavailable.</p>
      </Shell>
    )
  }
  const canEdit = Boolean(user && (value.authors.length === 0 || value.authors.some(author => author.id === user.profile)))
  const description = value.about.replace(/[#_*`>\[\]()]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200)
  return (
    <Shell
      title={value.name}
      subtitle={<Attribution people={value.authors} intro="a practice by" />}
      actions={canEdit ? (
        editing
          ? <ButtonLink secondary href={`Practice?id=${encodeURIComponent(id)}`}>Done</ButtonLink>
          : <ButtonLink secondary href={`Practice?id=${encodeURIComponent(id)}&edit`}>Edit</ButtonLink>
      ) : null}
    >
      <title>{value.name} — a social practice</title>
      <meta name="description" content={description} />
      {editing && canEdit ? <PracticeEditor value={value} /> : (
        <div className="mx-auto max-w-2xl rounded-lg bg-slate-100 p-4 leading-relaxed text-slate-700">
          <Markdown source={value.about} />
        </div>
      )}
      {user ? <AddToLists practiceID={id} /> : null}
      <section className="mt-10">
        <h2 className="mb-3 text-xl font-semibold">This practice is on the following lists</h2>
        <ListGrid lists={value.lists} />
      </section>
    </Shell>
  )
}

function AddToLists({ practiceID }: { practiceID: string }) {
  useUser({ required: true })
  const lists = useQuery(myLists, {})
  const [state, action, pending] = useMutationAction(setListPractice)
  return (
    <Panel className="my-8">
      <h2 className="mb-3 text-xl font-semibold">Add to your lists</h2>
      <MutationError error={state.error} />
      <div className="flex flex-wrap gap-2">
        {lists.map(list => {
          const included = list.practiceMemberships.some(membership => membership.practice_id === practiceID)
          return (
            <form action={action} key={list.id}>
              <input type="hidden" name="listId" value={list.id} />
              <input type="hidden" name="practiceId" value={practiceID} />
              <input type="hidden" name="included" value={String(!included)} />
              <Button secondary selected={included} disabled={pending}>
                {included ? "✓ " : "+ "}{list.name}
              </Button>
            </form>
          )
        })}
      </div>
    </Panel>
  )
}

function PracticeEditor({ value }) {
  useUser({ required: true })
  const [state, action, pending] = useMutationAction(updatePractice)
  return (
    <form className="mt-4 grid max-w-xl gap-3" action={action}>
      <MutationError error={state.error} />
      <input type="hidden" name="practiceId" value={value.id} />
      <label className="grid gap-1">
        Name
        <TextInput name="name" defaultValue={value.name} required />
      </label>
      <label className="grid gap-1">
        About
        <TextArea className="min-h-36 resize-y" name="about" defaultValue={value.about} required />
      </label>
      <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save practice"}</Button>
    </form>
  )
}
