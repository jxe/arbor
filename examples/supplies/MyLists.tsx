import { useEffect } from "react"
import {
  useMutationAction,
  useNavigate,
  useQuery,
  useUser,
} from "arbor/react"
import { arbor, mutation, publicError } from "arbor/data"
import { z } from "zod"
import { myLists } from "./scripts/queries"
import {
  Button,
  ListGrid,
  MutationError,
  Select,
  Shell,
  TextInput,
} from "./components/shared"

const suppliesData = arbor("./data")
const lists = arbor("./data/lists").children

export const createList = mutation(
  suppliesData,
  z.object({
    name: z.string().trim().min(1),
    visibility: z.enum(["public", "private"]),
  }),
  async ({ user, tx, id, now }, input) => {
    if (!user) throw publicError("user-required", "This operation requires an Arbor user")
    const listId = id("list")
    await tx.insert(lists, {
      id: listId,
      owner_profile: user.profile,
      name: input.name,
      about: "",
      visibility: input.visibility,
      kind: "standard",
      allow_arbor_user_edits: false,
      created_at: now,
      updated_at: now,
    })
    return { id: listId }
  },
)

export default function MyLists() {
  useUser({ required: true })
  const lists = useQuery(myLists)
  const [state, action, pending] = useMutationAction(createList)
  const navigate = useNavigate()

  useEffect(() => {
    if (state.result) navigate(`List?id=${encodeURIComponent(state.result.id)}&edit`)
  }, [navigate, state.result])

  return (
    <Shell title="My lists">
      <title>My lists — Meaning Supplies</title>
      <meta name="description" content="Your lists of social practices" />
      <meta name="robots" content="noindex" />

      <form className="mb-6 flex flex-wrap items-center gap-2" action={action}>
        <TextInput name="name" placeholder="New list name" required />
        <Select name="visibility" defaultValue="public">
          <option value="public">Public</option>
          <option value="private">Private</option>
        </Select>
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create list"}
        </Button>
      </form>
      <MutationError error={state.error} />
      <ListGrid lists={lists} />
    </Shell>
  )
}
