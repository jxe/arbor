import { useMemo, useState } from "react";
import type { NodeSummary } from "@arbor/core";
import type { NodeSnapshot } from "@arbor/client";
import { serializeMarkdown } from "@arbor/editor";
import { api } from "./api.ts";
import { nodeDocument } from "./node-presentation.ts";

export function CollectionView({ node, items, nextCursor, navigate, loadMore, refresh }: {
  node: NodeSnapshot;
  items: NodeSummary[];
  nextCursor: string | null;
  navigate: (path: string) => void;
  loadMore: () => Promise<void>;
  refresh: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const scopedApi = api.scoped(node.ref.tree);
  const columns = useMemo(() => [...new Set(items.flatMap((item) => Object.keys(item.properties)))], [items]);
  if (error) return <div className="empty error">{error}</div>;
  const edit = async (row: NodeSummary, field: string, value: string) => {
    if (row.capabilities.properties?.writable !== true) return;
    try {
      const record = await scopedApi.node(row.ref);
      const document = nodeDocument(record);
      const revision = record.capabilities.content?.revision;
      if (!document || !revision) return;
      await scopedApi.write(row.ref, {
        baseContentRevision: revision,
        source: serializeMarkdown(document, document.blocks, { [field]: value }),
      });
      refresh();
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
          && <button className="quiet" onClick={() => navigate(row.ref.path)}>Open</button>}</td></tr>)}</tbody>
    </table></div>
    {nextCursor && <button onClick={() => void loadMore()}>Load more</button>}
  </section>;
}
