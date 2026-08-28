import { useMemo, useState } from "react";
import type { JSONValue, NodeRef, NodeSummary } from "@arbor/core";
import type { NodeSnapshot } from "@arbor/client";
import { api } from "./api.ts";

type PropertyWriter = (
  ref: NodeRef,
  basePropertiesRevision: string,
  properties: Record<string, JSONValue>,
) => Promise<unknown>;

function editedValue(current: JSONValue | undefined, input: string): JSONValue {
  if (typeof current === "number") {
    const value = Number(input);
    if (!Number.isFinite(value)) throw new TypeError("The value must be a finite number");
    return value;
  }
  if (typeof current === "boolean") {
    if (input === "true") return true;
    if (input === "false") return false;
    throw new TypeError("The value must be true or false");
  }
  if (current === null && input === "null") return null;
  return input;
}

export async function writeCollectionProperty(
  write: PropertyWriter,
  row: NodeSummary,
  field: string,
  input: string,
): Promise<boolean> {
  const capability = row.capabilities.properties;
  if (!capability?.writable) return false;
  await write(row.ref, capability.revision, {
    ...row.properties,
    [field]: editedValue(row.properties[field], input),
  });
  return true;
}

export function collectionRowNavigationTarget(row: NodeSummary): NodeRef {
  return row.ref;
}

export function CollectionView({ node, items, nextCursor, navigate, loadMore, refresh }: {
  node: NodeSnapshot;
  items: NodeSummary[];
  nextCursor: string | null;
  navigate: (target: string | NodeRef) => void;
  loadMore: () => Promise<void>;
  refresh: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const scopedApi = api.scoped(node.ref.tree);
  const columns = useMemo(() => [...new Set(items.flatMap((item) => Object.keys(item.properties)))], [items]);
  if (error) return <div className="empty error">{error}</div>;
  const edit = async (row: NodeSummary, field: string, value: string) => {
    try {
      if (await writeCollectionProperty(scopedApi.writeProperties, row, field, value)) refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return <section className="collection">
    {items.flatMap((item) => item.diagnostics).map((item) => <div className="diagnostic" key={`${item.code}:${item.path ?? ""}`}>{item.message}</div>)}
    <div className="table-scroll"><table><thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}<th /></tr></thead>
      <tbody>{items.map((row) => <tr key={`${row.ref.path}:${row.ref.stableKey ?? ""}`}>{columns.map((column) => <td key={column}>{row.capabilities.properties?.writable
        ? <input defaultValue={String(row.properties[column] ?? "")} onBlur={(event) => void edit(row, column, event.target.value)} />
        : String(row.properties[column] ?? "")}</td>)}<td>{(row.capabilities.content || row.capabilities.children)
          && <button className="quiet" onClick={() => navigate(collectionRowNavigationTarget(row))}>Open</button>}</td></tr>)}</tbody>
    </table></div>
    {nextCursor && <button onClick={() => void loadMore()}>Load more</button>}
  </section>;
}
