import { arbor, mutation, publicError } from "arbor/data"
import { z } from "zod"

const suppliesData = arbor("../data")
const list_contributors = arbor("../data/list_contributors").children
const list_practices = arbor("../data/list_practices").children
const lists = arbor("../data/lists").children
const practice_tags = arbor("../data/practice_tags").children

// React Actions submit strings; imperative callers may already have booleans.
export const booleanInput = z.union([z.boolean(), z.stringbool()])

export async function requireListEditor(tx, listId: string, user) {
  if (!user) throw publicError("user-required", "This operation requires an Arbor user")
  const value = await tx.one(lists, { id: listId })
  if (!value) throw publicError("not-found", "List not found")
  if (value.owner_profile !== user.profile && !value.allow_arbor_user_edits) {
    throw publicError("permission-denied", "You cannot edit this list")
  }
  return value
}

export async function recordContributor(tx, list, profile: string, now: string) {
  if (list.owner_profile === profile) return
  await tx.upsert(
    list_contributors,
    { list_id: list.id, profile },
    {
      create: {
        list_id: list.id,
        profile,
        first_contributed_at: now,
        last_contributed_at: now,
      },
      update: { last_contributed_at: now },
    },
  )
}

export function orderedListPractices(tx, listId: string) {
  return tx.ordered(list_practices, {
    within: { list_id: listId },
    key: "practice_id",
    order: "position",
  })
}

export async function touchList(tx, listId: string, now: string) {
  await tx.update(lists, { id: listId }, { updated_at: now })
}

// Membership is shared by List and Practice. The ordered relation owns safe
// append/removal under concurrent writers; callers never derive a position.
export const setListPractice = mutation(
  suppliesData,
  z.object({
    listId: z.string().uuid(),
    practiceId: z.string().uuid(),
    included: booleanInput,
  }),
  async ({ user, tx, now }, input) => {
    const list = await requireListEditor(tx, input.listId, user)
    const existing = await tx.one(list_practices, {
      list_id: input.listId,
      practice_id: input.practiceId,
    })

    let changed = false
    const ordered = orderedListPractices(tx, input.listId)
    if (input.included && !existing) {
      await ordered.append({ practice_id: input.practiceId })
      changed = true
    } else if (!input.included && existing) {
      await tx.deleteWhere(practice_tags, {
        list_id: input.listId,
        practice_id: input.practiceId,
      })
      await ordered.remove(input.practiceId)
      changed = true
    }

    if (changed) {
      await recordContributor(tx, list, user.profile, now)
      await touchList(tx, list.id, now)
    }
    return { ok: true }
  },
)
