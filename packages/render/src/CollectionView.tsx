import { useEffect, useState } from "react";
import type { CollectionPage } from "@arbor/core";
import type { NodeSnapshot } from "@arbor/client";
import { serializeMarkdown } from "@arbor/editor";
import { api } from "./api.ts";

export function CollectionView({ node, navigate, refresh }: { node: NodeSnapshot; navigate: (path: string) => void; refresh: () => void }) {
  const [page, setPage] = useState<CollectionPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const table = node.path.split("/").pop();
    api.collection(node.path).then(setPage).catch((error: Error) => setError(error.message));
  }, [node.path, node.contentRevision]);
  if (error) return <div className="empty error">{error}</div>;
  if (!page) return <div className="empty">Loading collection…</div>;
  const edit = async (rowPath: string | undefined, field: string, value: string) => {
    if (!rowPath) return;
    const path = `${node.path}/${rowPath}`.replaceAll("//", "/");
    const record = await api.node(path);
    if (!record.document) return;
    await api.write(path, {
      baseContentRevision: record.contentRevision!,
      source: serializeMarkdown(record.document, record.document.blocks, { [field]: value }),
    });
    refresh();
  };
  return <section className="collection">
    {page.diagnostics.map((item) => <div className="diagnostic" key={item.code}>{item.message}</div>)}
    <div className="table-scroll"><table><thead><tr>{page.columns.map((column) => <th key={column}>{column}</th>)}<th /></tr></thead>
      <tbody>{page.rows.map((row) => <tr key={row.key}>{page.columns.map((column) => <td key={column}>{page.editable
        ? <input defaultValue={String(row.values[column] ?? "")} onBlur={(event) => edit(row.path, column, event.target.value)} />
        : String(row.values[column] ?? "")}</td>)}<td>{row.path && <button className="quiet" onClick={() => navigate(`${node.path}/${row.path}`.replaceAll("//", "/"))}>Open</button>}</td></tr>)}</tbody>
    </table></div>
    {page.nextCursor && <button onClick={async () => setPage(await api.collection(node.path, page.nextCursor))}>Next page</button>}
  </section>;
}
