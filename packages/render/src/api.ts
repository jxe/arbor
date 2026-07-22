import type { CollectionPage, NodeWriteRequest, SearchResult, TreeNode } from "@arbor/core";

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
  trash: (path: string) => request<{ trashPath: string }>(`/v/node${path}`, { method: "DELETE" }),
  restore: (path: string) => request<{ path: string }>("/v/restore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) }),
  recovery: (path: string) => request<Array<{ hash: string; markdown: string; status: string; changedAt: number }>>(`/v/recovery?path=${encodeURIComponent(path)}`),
  restoreBlock: (path: string, hash: string) => request<TreeNode>("/v/recovery/restore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, hash }) }),
  asset: async (directory: string, file: File) => request<{ path: string; markdownPath: string }>(`/v/assets?directory=${encodeURIComponent(directory)}`, { method: "POST", headers: { "x-filename": file.name, "content-type": file.type }, body: file }),
};
