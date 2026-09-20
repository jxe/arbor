/** Scalar identifiers shared by the node model and the protocol vocabulary. */
export type TreeID = string;
export type TreeRef = "local" | "system" | TreeID;
export type LogicalPath = string;
export type ContentRevision = string;
export type DirectoryRevision = string;
export type EventCursor = string;
export type Hash = `sha256:${string}`;

export const LOCAL_TREE: TreeRef = "local";
export const SYSTEM_TREE: TreeRef = "system";
