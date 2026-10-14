import { node, mutation, publicError } from "overstory/data"
import { z } from "zod"

const suppliesData = node("../data")
const contributions = node("../data/Contribution").children
const items = node("../data/Item").children
const lists = node("../data/List").children

// React Actions submit strings; imperative callers may already have booleans.
export const booleanInput = z.union([z.boolean(), z.stringbool()])

export async function requireListEditor(tx, listId: string, user) {
  if (!user) throw publicError("user-required", "This operation requires a Story user")
  const value = await tx.one(lists, { id: listId })
  if (!value) throw publicError("not-found", "List not found")
  if (value.owner !== user.profile && !value.openToEdits) {
    throw publicError("permission-denied", "You cannot edit this list")
  }
  return value
}

// A contribution's first and last are dates (schema.usl `Date`).
export async function recordContributor(tx, list, person: string, now: string) {
  if (list.owner === person) return
  const today = now.slice(0, 10)
  await tx.upsert(
    contributions,
    { list: list.id, person },
    {
      create: { list: list.id, person, first: today, last: today },
      update: { last: today },
    },
  )
}

export function orderedListPractices(tx, listId: string) {
  return tx.ordered(items, {
    within: { list: listId },
    key: "practice",
    order: "items_position",
  })
}

export async function touchList(tx, listId: string, now: string) {
  await tx.update(lists, { id: listId }, { modified: now })
}

// Membership is shared by List and Practice. The ordered relation owns safe
// append/removal under concurrent writers; callers never derive a position.
// A practice's tags belong to the practice (scoped by the tag's list), so
// removing it from a list keeps them for when it is added back.
export const setListPractice = mutation(
  suppliesData,
  z.object({
    listId: z.string().uuid(),
    practiceId: z.string().uuid(),
    included: booleanInput,
  }),
  async ({ user, tx, now }, input) => {
    const list = await requireListEditor(tx, input.listId, user)
    const existing = await tx.one(items, {
      list: input.listId,
      practice: input.practiceId,
    })

    let changed = false
    const ordered = orderedListPractices(tx, input.listId)
    if (input.included && !existing) {
      await ordered.append({ practice: input.practiceId })
      changed = true
    } else if (!input.included && existing) {
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
