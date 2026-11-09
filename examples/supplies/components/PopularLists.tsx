import { useQuery } from "overstory/react"
import { view } from "overstory/data"
import { List, listSummary } from "../scripts/views"
import { ListGrid } from "./shared"


// The one place Supplies orders on the host: the top 12 needs the order to cut.
export const popularLists = view(() =>
  List.all(l => [l.visibility.is("Public")])
    .orderBy(l => l.reactions.count().desc())
    .take(12)
    .map(listSummary))

export function PopularLists() {
  const lists = useQuery(popularLists)
  return <ListGrid lists={lists} />
}
