import { useEffect } from "react"
import {
  Markdown,
  useMutationAction,
  useNavigate,
  useQuery,
  useUser,
} from "arbor/react"
import {
  database,
  mutation,
  publicError,
  query,
} from "arbor/data"
import { z } from "zod"
import {
  booleanInput,
  orderedListPractices,
  recordContributor,
  requireListEditor,
  setListPractice,
  touchList,
} from "./scripts/mutations"
import {
  Attribution,
  Button,
  ButtonLink,
  MutationError,
  Panel,
  Select,
  Shell,
  TextArea,
  TextInput,
} from "./components/shared"

const suppliesData = database("./data")
const {
  arbor_profiles,
  list_practices,
  list_reactions,
  list_tags,
  lists,
  practice_authors,
  practice_tags,
  practices,
} = suppliesData.relations
const profileCard = arbor_profiles.pick("id", "name", "handle", "portrait")

export const list = query.maybe(
  lists,
  z.object({ id: z.string().uuid() }),
  (list, { input, user }) => ({
    where: [
      list.id.eq(input.id),
      list.visibility.eq("public").or(
        list.owner_profile.eq(user.profile),
      ),
    ],
    select: {
      ...list.pick("id", "name", "about", "visibility", "kind"),
      allowArborUserEdits: list.allow_arbor_user_edits,
      ownerProfile: list.owner_profile,
      owner: list.owner(profileCard),
      contributors: list.contributors({
        orderBy: person => person.name,
        select: profileCard,
      }),
      items: list.items({
        orderBy: item => item.position,
        select: item => ({
          position: item.position,
          practice: item.practice(practice => ({
            ...practice.pick("id", "name", "about"),
            authors: practice.authors({
              orderBy: author => author.name,
              select: profileCard,
            }),
          })),
          tags: item.tags({
            orderBy: tag => tag.name,
            select: tag => tag.pick("id", "name", "color"),
          }),
        }),
      }),
      reactions: list.reactions({
        orderBy: reaction => reaction.profile,
        select: reaction => ({
          profile: reaction.person(profileCard),
          emoji: reaction.emoji,
        }),
      }),
      tags: list.tags({
        orderBy: tag => tag.name,
        select: tag => tag.pick("id", "name", "color"),
      }),
    },
  }),
)

export const practiceChoices = query.many(
  practices,
  practice => ({
    orderBy: practice.name,
    select: {
      ...practice.pick("id", "name", "about"),
      authors: practice.authors({
        orderBy: author => author.name,
        select: profileCard,
      }),
    },
  }),
)

export const renameList = mutation(
  suppliesData,
  z.object({ listId: z.string().uuid(), name: z.string().trim().min(1) }),
  async ({ user, tx, now }, input) => {
    const value = await requireListEditor(tx, input.listId, user)
    if (value.owner_profile !== user.profile) {
      throw publicError("permission-denied", "Only the owner can rename this list")
    }
    await tx.update(lists, { id: input.listId }, {
      name: input.name,
      updated_at: now,
    })
    return { ok: true }
  },
)

export const reorderList = mutation(
  suppliesData,
  z.object({ listId: z.string().uuid(), practiceIds: z.array(z.string().uuid()) }),
  async ({ user, tx, now }, input) => {
    const value = await requireListEditor(tx, input.listId, user)
    await orderedListPractices(tx, input.listId).replace(input.practiceIds)
    await recordContributor(tx, value, user.profile, now)
    await touchList(tx, value.id, now)
    return { ok: true }
  },
)

export const toggleListReaction = mutation(
  suppliesData,
  z.object({ listId: z.string().uuid() }),
  async ({ user, tx }, input) => {
    if (!user) throw publicError("user-required", "This operation requires an Arbor user")
    const value = await tx.one(lists, { id: input.listId })
    if (!value || value.visibility !== "public") {
      throw publicError("not-found", "Only public lists can be liked")
    }
    const key = { list_id: input.listId, profile: user.profile }
    const existing = await tx.one(list_reactions, key)
    if (existing) await tx.delete(list_reactions, key)
    else await tx.insert(list_reactions, { ...key, emoji: "👍" })
    return { reacted: !existing }
  },
)

export const setListSharing = mutation(
  suppliesData,
  z.object({
    listId: z.string().uuid(),
    visibility: z.enum(["public", "private"]),
    allowArborUserEdits: booleanInput,
  }),
  async ({ user, tx, now }, input) => {
    if (!user) throw publicError("user-required", "This operation requires an Arbor user")
    const value = await tx.one(lists, { id: input.listId })
    if (!value || value.owner_profile !== user.profile) {
      throw publicError("permission-denied", "Only the owner can change sharing")
    }
    await tx.update(lists, { id: input.listId }, {
      visibility: input.visibility,
      allow_arbor_user_edits: input.allowArborUserEdits,
      updated_at: now,
    })
    return { ok: true }
  },
)

export const createPractice = mutation(
  suppliesData,
  z.object({
    name: z.string().trim().min(1),
    about: z.string().trim().min(1),
    addToList: z.string().uuid().optional(),
  }),
  async ({ user, tx, id, now }, input) => {
    if (!user) throw publicError("user-required", "This operation requires an Arbor user")
    const practiceId = id("practice")
    await tx.insert(practices, {
      id: practiceId,
      name: input.name,
      about: input.about,
      created_at: now,
      updated_at: now,
    })
    await tx.insert(practice_authors, {
      practice_id: practiceId,
      author_profile: user.profile,
    })
    if (input.addToList) {
      const value = await requireListEditor(tx, input.addToList, user)
      await orderedListPractices(tx, value.id).append({ practice_id: practiceId })
      await recordContributor(tx, value, user.profile, now)
      await touchList(tx, value.id, now)
    }
    return { id: practiceId }
  },
)

export const setListKind = mutation(
  suppliesData,
  z.object({ listId: z.string().uuid(), kind: z.enum(["standard", "tagged"]) }),
  async ({ user, tx, now }, input) => {
    if (!user) throw publicError("user-required", "This operation requires an Arbor user")
    const value = await tx.one(lists, { id: input.listId })
    if (!value || value.owner_profile !== user.profile) {
      throw publicError("permission-denied", "Only the owner can change the list kind")
    }
    await tx.update(lists, { id: input.listId }, { kind: input.kind, updated_at: now })
    return { ok: true }
  },
)

export const createListTag = mutation(
  suppliesData,
  z.object({
    listId: z.string().uuid(),
    name: z.string().trim().min(1),
    color: z.string().trim().min(1).optional(),
  }),
  async ({ user, tx, id, now }, input) => {
    const value = await requireListEditor(tx, input.listId, user)
    if (value.owner_profile !== user.profile) {
      throw publicError("permission-denied", "Only the owner can create tags")
    }
    const tagId = id("list-tag")
    await tx.insert(list_tags, {
      list_id: input.listId,
      id: tagId,
      name: input.name,
      color: input.color ?? null,
    })
    await touchList(tx, value.id, now)
    return { id: tagId }
  },
)

export const deleteListTag = mutation(
  suppliesData,
  z.object({ listId: z.string().uuid(), tagId: z.string().uuid() }),
  async ({ user, tx, now }, input) => {
    const value = await requireListEditor(tx, input.listId, user)
    if (value.owner_profile !== user.profile) {
      throw publicError("permission-denied", "Only the owner can delete tags")
    }
    await tx.deleteWhere(practice_tags, { list_id: input.listId, tag_id: input.tagId })
    await tx.delete(list_tags, { list_id: input.listId, id: input.tagId })
    await touchList(tx, value.id, now)
    return { ok: true }
  },
)

export const setPracticeTag = mutation(
  suppliesData,
  z.object({
    listId: z.string().uuid(),
    practiceId: z.string().uuid(),
    tagId: z.string().uuid(),
    included: booleanInput,
  }),
  async ({ user, tx, now }, input) => {
    const value = await requireListEditor(tx, input.listId, user)
    const membership = await tx.one(list_practices, {
      list_id: input.listId,
      practice_id: input.practiceId,
    })
    if (!membership) throw publicError("invalid-input", "The practice is not on this list")
    const key = {
      list_id: input.listId,
      practice_id: input.practiceId,
      tag_id: input.tagId,
    }
    const existing = await tx.one(practice_tags, key)
    if (input.included && !existing) await tx.insert(practice_tags, key)
    if (!input.included && existing) await tx.delete(practice_tags, key)
    if (input.included !== Boolean(existing)) {
      await recordContributor(tx, value, user.profile, now)
      await touchList(tx, value.id, now)
    }
    return { ok: true }
  },
)

export const duplicateList = mutation(
  suppliesData,
  z.object({ listId: z.string().uuid() }),
  async ({ user, tx, id, now }, input) => {
    if (!user) throw publicError("user-required", "This operation requires an Arbor user")
    const newListId = id("list")
    const original = await tx.one(lists, { id: input.listId })
    if (!original || (original.visibility === "private" && original.owner_profile !== user.profile)) {
      throw publicError("not-found", "List not found")
    }
    await tx.insert(lists, {
      id: newListId,
      owner_profile: user.profile,
      name: `Copy of ${original.name}`,
      about: original.about,
      visibility: original.visibility,
      kind: "standard",
      allow_arbor_user_edits: false,
      created_at: now,
      updated_at: now,
    })
    const memberships = await tx.many(list_practices, { list_id: original.id }, {
      orderBy: [["position", "asc"], ["practice_id", "asc"]],
    })
    const ordered = orderedListPractices(tx, newListId)
    for (const membership of memberships) {
      await ordered.append({ practice_id: membership.practice_id })
    }
    return { id: newListId }
  },
)

export default function List({ search }: { search: URLSearchParams }) {
  const id = search.get("id")
  if (!id) {
    return (
      <Shell title="List unavailable">
        <title>List unavailable</title>
        <p>This link has no list ID.</p>
      </Shell>
    )
  }
  return <ListContent id={id} editing={search.has("edit")} />
}

function ListContent({ id, editing }: { id: string; editing: boolean }) {
  const value = useQuery(list, { id })
  const user = useUser()
  const [reactionState, reactionAction, reactionPending] = useMutationAction(toggleListReaction)
  const [duplicateState, duplicateAction, duplicatePending] = useMutationAction(duplicateList)
  const navigate = useNavigate()

  useEffect(() => {
    if (duplicateState.result) navigate(`List?id=${encodeURIComponent(duplicateState.result.id)}&edit`)
  }, [duplicateState.result, navigate])

  if (!value) {
    return (
      <Shell title="List unavailable">
        <title>List unavailable</title>
        <p>This list does not exist or is not visible to you.</p>
      </Shell>
    )
  }

  const canEdit = Boolean(user && (value.ownerProfile === user.profile || value.allowArborUserEdits))
  const userReacted = Boolean(user && value.reactions.some(reaction => reaction.profile.id === user.profile))
  const attribution = [value.owner, ...value.contributors.filter(person => person.id !== value.owner.id)]
  const actions = (
    <>
      {canEdit ? (
        editing
          ? <ButtonLink secondary href={`List?id=${encodeURIComponent(id)}`}>Done</ButtonLink>
          : <ButtonLink secondary href={`List?id=${encodeURIComponent(id)}&edit`}>Edit</ButtonLink>
      ) : null}
      {user && value.visibility === "public" ? (
        <form action={reactionAction}>
          <input type="hidden" name="listId" value={id} />
          <Button secondary selected={userReacted} disabled={reactionPending}>
            👍 {value.reactions.length}
          </Button>
        </form>
      ) : null}
      {user ? (
        <form action={duplicateAction}>
          <input type="hidden" name="listId" value={id} />
          <Button secondary disabled={duplicatePending}>
            {duplicatePending ? "Duplicating…" : "Duplicate"}
          </Button>
        </form>
      ) : null}
    </>
  )

  return (
    <Shell
      title={editing && canEdit ? <RenameList id={id} name={value.name} /> : value.name}
      subtitle={
        <div className="flex items-center justify-center gap-4">
          <Attribution people={attribution} intro="a list by" />
          {value.visibility === "private" ? <span className="text-sm text-slate-500">Private</span> : null}
        </div>
      }
      actions={actions}
    >
      <title>{value.name} — Meaning Supplies</title>
      <meta name="description" content={`A list of ${value.items.length} social practices by ${value.owner.name}.`} />
      <MutationError error={reactionState.error} />
      <MutationError error={duplicateState.error} />
      {value.about ? <div className="leading-relaxed text-slate-700"><Markdown source={value.about} /></div> : null}

      {editing && canEdit ? <ListEditor value={value} /> : (
        <div className="grid grid-cols-1 items-start gap-5 md:grid-cols-3">
          {value.items.map(item => (
            <article className="flex min-w-0 flex-col rounded-lg border border-slate-200 bg-slate-50 p-4" key={item.practice.id}>
              <h2 className="text-lg font-semibold"><a href={`Practice?id=${encodeURIComponent(item.practice.id)}`}>{item.practice.name}</a></h2>
              <Attribution people={item.practice.authors} intro="by" />
              <div className="mt-3 max-h-40 overflow-hidden leading-relaxed text-slate-600"><Markdown source={item.practice.about} /></div>
              {item.tags.length ? (
                <div className="mt-auto flex flex-wrap gap-1.5 pt-3">
                  {item.tags.map(tag => (
                    <span className="rounded-full border border-slate-300 px-2 py-0.5 text-xs text-slate-600" key={tag.id} style={tag.color ? { background: tag.color, color: "white" } : undefined}>
                      {tag.name}
                    </span>
                  ))}
                </div>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </Shell>
  )
}

function RenameList({ id, name }: { id: string; name: string }) {
  const [state, action, pending] = useMutationAction(renameList)
  return (
    <form className="inline-flex flex-wrap items-center justify-center gap-2" action={action}>
      <input type="hidden" name="listId" value={id} />
      <TextInput className="min-w-80 text-center" name="name" defaultValue={name} required />
      <Button secondary disabled={pending}>{pending ? "Saving…" : "Save name"}</Button>
      <MutationError error={state.error} />
    </form>
  )
}

function movedPracticeIDs(items, index: number, difference: number) {
  const ids = items.map(item => item.practice.id)
  const target = index + difference
  const [moved] = ids.splice(index, 1)
  ids.splice(target, 0, moved)
  return ids
}

function ListEditor({ value }) {
  const user = useUser({ required: true })
  const choices = useQuery(practiceChoices)
  const [membershipState, membershipAction, membershipPending] = useMutationAction(setListPractice)
  const [reorderState, reorderAction, reorderPending] = useMutationAction(reorderList)
  const [sharingState, sharingAction, sharingPending] = useMutationAction(setListSharing)
  const [kindState, kindAction, kindPending] = useMutationAction(setListKind)
  const [createTagState, createTagAction, createTagPending] = useMutationAction(createListTag)
  const [deleteTagState, deleteTagAction, deleteTagPending] = useMutationAction(deleteListTag)
  const [practiceTagState, practiceTagAction, practiceTagPending] = useMutationAction(setPracticeTag)
  const isOwner = user.profile === value.ownerProfile
  const onList = new Set(value.items.map(item => item.practice.id))

  return (
    <div className="grid gap-4">
      <MutationError error={membershipState.error} />
      <MutationError error={reorderState.error} />
      <MutationError error={sharingState.error} />
      <MutationError error={kindState.error} />
      <MutationError error={createTagState.error} />
      <MutationError error={deleteTagState.error} />
      <MutationError error={practiceTagState.error} />

      <Panel>
        <h2 className="mb-3 text-xl font-semibold">Sharing</h2>
        <form className="grid max-w-lg gap-3" action={sharingAction}>
          <input type="hidden" name="listId" value={value.id} />
          <label className="grid gap-1">
            Visibility
            <Select name="visibility" defaultValue={value.visibility}>
              <option value="public">Public</option>
              <option value="private">Private</option>
            </Select>
          </label>
          <label className="grid gap-1">
            Editing
            <Select name="allowArborUserEdits" defaultValue={String(value.allowArborUserEdits)}>
              <option value="false">Only the owner may edit</option>
              <option value="true">Any signed-in Arbor user may edit</option>
            </Select>
          </label>
          <Button secondary disabled={sharingPending}>{sharingPending ? "Saving…" : "Save sharing"}</Button>
        </form>
        {isOwner ? (
          <form className="mt-3" action={kindAction}>
            <input type="hidden" name="listId" value={value.id} />
            <input type="hidden" name="kind" value={value.kind === "tagged" ? "standard" : "tagged"} />
            <Button secondary disabled={kindPending}>
              {value.kind === "tagged" ? "Use a standard list" : "Use a tagged list"}
            </Button>
          </form>
        ) : null}
      </Panel>

      <Panel>
        <h2 className="mb-3 text-xl font-semibold">Practices on this list</h2>
        <div className="grid gap-2">
          {value.items.map((item, index) => (
            <div className="flex items-center justify-between gap-3 rounded-md border border-slate-200 bg-white px-3 py-2" key={item.practice.id}>
              <span>
                {item.practice.name}
                {value.kind === "tagged" && value.tags.length ? (
                  <span className="mt-2 flex flex-wrap gap-2">
                    {value.tags.map(tag => {
                      const included = item.tags.some(value => value.id === tag.id)
                      return (
                        <form action={practiceTagAction} key={tag.id}>
                          <input type="hidden" name="listId" value={value.id} />
                          <input type="hidden" name="practiceId" value={item.practice.id} />
                          <input type="hidden" name="tagId" value={tag.id} />
                          <input type="hidden" name="included" value={String(!included)} />
                          <Button secondary selected={included} disabled={practiceTagPending}>
                            {included ? "✓ " : "+ "}{tag.name}
                          </Button>
                        </form>
                      )
                    })}
                  </span>
                ) : null}
              </span>
              <span className="flex flex-wrap gap-1.5">
                {index > 0 ? (
                  <form action={reorderAction}>
                    <input type="hidden" name="listId" value={value.id} />
                    {movedPracticeIDs(value.items, index, -1).map(id => <input key={id} type="hidden" name="practiceIds" value={id} />)}
                    <Button secondary aria-label={`Move ${item.practice.name} up`} disabled={reorderPending}>↑</Button>
                  </form>
                ) : null}
                {index < value.items.length - 1 ? (
                  <form action={reorderAction}>
                    <input type="hidden" name="listId" value={value.id} />
                    {movedPracticeIDs(value.items, index, 1).map(id => <input key={id} type="hidden" name="practiceIds" value={id} />)}
                    <Button secondary aria-label={`Move ${item.practice.name} down`} disabled={reorderPending}>↓</Button>
                  </form>
                ) : null}
                <form action={membershipAction}>
                  <input type="hidden" name="listId" value={value.id} />
                  <input type="hidden" name="practiceId" value={item.practice.id} />
                  <input type="hidden" name="included" value="false" />
                  <Button secondary disabled={membershipPending}>Remove</Button>
                </form>
              </span>
            </div>
          ))}
        </div>
      </Panel>

      {value.kind === "tagged" && isOwner ? (
        <Panel>
          <h2 className="mb-3 text-xl font-semibold">Tags</h2>
          <div className="mb-3 flex flex-wrap gap-2">
            {value.tags.map(tag => (
              <form action={deleteTagAction} key={tag.id}>
                <input type="hidden" name="listId" value={value.id} />
                <input type="hidden" name="tagId" value={tag.id} />
                <Button secondary aria-label={`Delete ${tag.name}`} disabled={deleteTagPending}>{tag.name} ×</Button>
              </form>
            ))}
          </div>
          <form className="flex flex-wrap items-center gap-2" action={createTagAction}>
            <input type="hidden" name="listId" value={value.id} />
            <TextInput name="name" placeholder="New tag" required />
            <Button disabled={createTagPending}>{createTagPending ? "Adding…" : "Add tag"}</Button>
          </form>
        </Panel>
      ) : null}

      <Panel>
        <h2 className="mb-3 text-xl font-semibold">Add practices</h2>
        <div className="flex flex-wrap gap-2">
          {choices.filter(practice => !onList.has(practice.id)).map(practice => (
            <form action={membershipAction} key={practice.id}>
              <input type="hidden" name="listId" value={value.id} />
              <input type="hidden" name="practiceId" value={practice.id} />
              <input type="hidden" name="included" value="true" />
              <Button secondary disabled={membershipPending}>+ {practice.name}</Button>
            </form>
          ))}
        </div>
        <NewPractice listId={value.id} />
      </Panel>
    </div>
  )
}

function NewPractice({ listId }: { listId: string }) {
  const [state, action, pending] = useMutationAction(createPractice)
  return (
    <form className="mt-4 grid max-w-xl gap-3" action={action}>
      <h3 className="text-lg font-semibold">Create a practice</h3>
      <MutationError error={state.error} />
      <input type="hidden" name="addToList" value={listId} />
      <TextInput name="name" placeholder="Practice name" required />
      <TextArea className="min-h-36 resize-y" name="about" placeholder="About this practice" required />
      <Button disabled={pending}>{pending ? "Creating…" : "Create and add"}</Button>
    </form>
  )
}
