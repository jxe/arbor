import type { CollectionPage, NodeWriteRequest, SearchResult, TreeNode } from "@arbor/core";
import type { FsMutationRequest, FsMutationResult } from "@arbor/fs";

export interface BrowserImportEntry {
  path: string;
  kind: "file" | "directory";
  file?: File;
}

async function request<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const value = await response.json() as T & { error?: string };
  if (!response.ok) {
    const error = new Error(value.error ?? response.statusText) as Error & { status: number; payload: typeof value };
    error.status = response.status;
    error.payload = value;
    throw error;
  }
  return value;
}

export const api = {
  node: (path: string) => request<TreeNode>(`/v/tree${path === "/" ? "/" : path}`),
  collection: (path: string, cursor?: string | null) => request<CollectionPage>(`/v/collection${path}?cursor=${encodeURIComponent(cursor ?? "0")}`),
  search: (query: string) => request<SearchResult[]>(`/v/search?q=${encodeURIComponent(query)}`),
  write: (path: string, body: NodeWriteRequest) => request<TreeNode>(`/v/node${path}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  mutate: (body: FsMutationRequest) => request<FsMutationResult>("/v/fs/mutate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  import: (destination: string, entries: BrowserImportEntry[]) => {
    const form = new FormData();
    form.set("destination", destination);
    const manifest = entries.map((entry, index) => {
      if (entry.kind === "directory") return { path: entry.path, kind: entry.kind };
      const field = `file-${index}`;
      if (!entry.file) throw new Error(`Missing imported file: ${entry.path}`);
      form.set(field, entry.file, entry.file.name);
      return { path: entry.path, kind: entry.kind, field };
    });
    form.set("manifest", JSON.stringify(manifest));
    return request<FsMutationResult>("/v/fs/import", { method: "POST", body: form });
  },
  trash: (path: string) => request<{ trashPath: string }>(`/v/node${path}`, { method: "DELETE" }),
  restore: (path: string) => request<{ path: string }>("/v/restore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) }),
  recovery: (path: string) => request<Array<{ hash: string; markdown: string; status: string; changedAt: number }>>(`/v/recovery?path=${encodeURIComponent(path)}`),
  restoreBlock: (path: string, hash: string) => request<TreeNode>("/v/recovery/restore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, hash }) }),
  asset: async (directory: string, file: File) => request<{ path: string; markdownPath: string }>(`/v/assets?directory=${encodeURIComponent(directory)}`, { method: "POST", headers: { "x-filename": file.name, "content-type": file.type }, body: file }),
};
