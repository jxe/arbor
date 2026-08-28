import type {
  ArborSyncErrorCode,
  ContentWorkspaceOperation,
  MutationEffect,
  NodeRef,
  NodeResponse,
  NodeWriteRequest,
} from "@arbor/core";
import { canonicalJSONString, isPageID, parseCanonicalStableKey } from "@arbor/core";
import { replaceFrontmatter } from "@arbor/editor";
import type { FsWriteResult, WorkspaceFS } from "@arbor/fs";
import {
  CollectionMutationMismatchError,
  CollectionPropertyConflictError,
  CollectionPropertyWriteError,
  CollectionSourceConflictError,
  type CollectionWriteTarget,
} from "@arbor/stores";
import type { ChildProvider } from "./child-provider.ts";
import { expandedNodeProperties, type ExpandedNode } from "./node-sampling.ts";
import { changedPropertyNames } from "./property-changes.ts";

type PropertyWrite = Extract<ContentWorkspaceOperation, { op: "writeProperties" }>;

export interface FilesystemPropertyWriteHost {
  tree: string;
  mutationID: string;
  provider: ChildProvider;
  fs(): WorkspaceFS | Promise<WorkspaceFS>;
  expandedNode(path: string): Promise<ExpandedNode>;
  snapshot(ref: NodeRef): Promise<NodeResponse>;
  snapshotCurrent(node: ExpandedNode): NodeResponse;
  mutationRef(path: string, pageID?: string, stableKey?: string | null): NodeRef;
  writeMarkdown(
    path: string,
    request: NodeWriteRequest,
    options: Parameters<WorkspaceFS["writeMarkdown"]>[2],
  ): Promise<ExpandedNode>;
  error(
    code: ArborSyncErrorCode,
    message: string,
    status: number,
    details?: Record<string, unknown>,
  ): Error;
  assertWritableProperties?(ref: NodeRef): Promise<void>;
  onExpected?(effects: MutationEffect[]): void | Promise<void>;
  onMaterialized?(effects: MutationEffect[]): void | Promise<void>;
  afterProviderCommit?(): void | Promise<void>;
}

/** Shared provider-neutral implementation of a filesystem property mutation. */
export async function writeFilesystemProperties(
  operation: PropertyWrite,
  path: string,
  target: CollectionWriteTarget | null | undefined,
  host: FilesystemPropertyWriteHost,
): Promise<MutationEffect> {
  const fail = host.error;
  if (target?.backing === "sqlite") {
    try {
      const row = await host.provider.writeSQLiteProperties(
        target,
        operation.ref,
        operation.basePropertiesRevision,
        operation.properties,
        { scope: host.tree, id: host.mutationID },
      );
      const effect: MutationEffect = {
        kind: "updated",
        ref: host.mutationRef(`${target.parentPath}/${row.path}`, undefined, row.stableKey),
        propertiesRevision: row.revision,
        changedProperties: changedPropertyNames(target.properties, operation.properties),
      };
      await host.onMaterialized?.([effect]);
      return effect;
    } catch (error) {
      if (error instanceof CollectionPropertyConflictError) {
        throw fail("stale-properties-revision", error.message, 409, {
          path: operation.ref.path,
          current: await host.snapshot(operation.ref).catch(() => undefined),
        });
      }
      if (error instanceof CollectionMutationMismatchError) {
        throw fail("mutation-mismatch", error.message, 409, { mutationID: host.mutationID });
      }
      if (error instanceof CollectionPropertyWriteError) {
        throw fail("unsupported-operation", error.message, 422, { path: operation.ref.path });
      }
      if (error instanceof Error && /constraint/i.test(error.message)) {
        throw fail("conflict", error.message, 409, { path: operation.ref.path });
      }
      throw error;
    }
  }

  if (target && (target.backing === "csv" || target.backing === "json" || target.backing === "jsonl")) {
    try {
      const prepared = await host.provider.prepareFileProperties(
        target,
        operation.ref,
        operation.basePropertiesRevision,
        operation.properties,
      );
      const effect: MutationEffect = {
        kind: "updated",
        ref: host.mutationRef(prepared.path, undefined, operation.ref.stableKey),
        propertiesRevision: prepared.revision,
        changedProperties: changedPropertyNames(target.properties, prepared.properties),
      };
      await host.onExpected?.([effect]);
      await host.provider.commitFileProperties(prepared);
      await host.afterProviderCommit?.();
      await host.onMaterialized?.([effect]);
      return effect;
    } catch (error) {
      if (error instanceof CollectionPropertyConflictError || error instanceof CollectionSourceConflictError) {
        throw fail("stale-properties-revision", error.message, 409, {
          path: operation.ref.path,
          current: await host.snapshot(operation.ref).catch(() => undefined),
        });
      }
      if (error instanceof CollectionPropertyWriteError) {
        throw fail("unsupported-operation", error.message, 422, { path: operation.ref.path });
      }
      throw error;
    }
  }

  await host.assertWritableProperties?.(operation.ref);
  if (target && target.backing !== "markdown") {
    throw fail("read-only", `${target.backing} rollup rows are not directly writable yet`, 422, {
      path: operation.ref.path,
    });
  }
  const current = await host.expandedNode(path);
  if (!current.document) throw fail("unsupported-operation", `${path} has no editable properties`, 422, { path });
  const currentRevision = target?.revision ?? current.propertiesRevision ?? current.revision;
  if (currentRevision !== operation.basePropertiesRevision) {
    throw fail("stale-properties-revision", "The node properties changed since they were read", 409, {
      path,
      current: target ? await host.snapshot(operation.ref) : host.snapshotCurrent(current),
    });
  }

  let properties = operation.properties;
  let identityProperties: readonly string[] = [];
  if (target) {
    try {
      const prepared = await host.provider.prepareMarkdownProperties(target.directory, operation.properties);
      properties = prepared.properties;
      identityProperties = prepared.identityRule?.properties ?? [];
    } catch (error) {
      if (error instanceof CollectionPropertyWriteError) {
        throw fail("unsupported-operation", error.message, 422, { path });
      }
      throw error;
    }
    for (const name of identityProperties) {
      if (canonicalJSONString(properties[name]) !== canonicalJSONString(target.properties[name])) {
        throw fail("invalid-reference", `Identity property ${name} is immutable`, 422, { path });
      }
    }
  }
  const identity = operation.ref.stableKey ? parseCanonicalStableKey(operation.ref.stableKey) : null;
  for (const [name, value] of identity ?? []) {
    if (canonicalJSONString(properties[name]) !== canonicalJSONString(value)) {
      throw fail("invalid-reference", `Identity property ${name} is immutable`, 422, { path });
    }
  }
  const currentProperties = expandedNodeProperties(current);
  if (isPageID(currentProperties.id) && properties.id !== currentProperties.id) {
    throw fail("invalid-reference", "Identity property id is immutable", 422, { path });
  }

  const source = `${replaceFrontmatter(current.document.frontmatterSource, properties) ?? ""}${current.document.bodySource}`;
  const changedProperties = changedPropertyNames(target?.properties ?? currentProperties, properties);
  const propertyEffect = (result: FsWriteResult): MutationEffect => ({
    kind: "updated",
    ref: host.mutationRef(result.node.path, result.pageID, operation.ref.stableKey),
    contentRevision: result.byteRevision,
    propertiesRevision: result.byteRevision,
    changedProperties,
    ...(!target && result.node.kind === "directory" ? { directoryRevision: result.byteRevision } : {}),
  });
  const saved = await host.writeMarkdown(path, { baseRevision: current.revision, source }, {
    onPrepared: host.onExpected ? async (result) => host.onExpected?.([propertyEffect(result)]) : undefined,
    onMaterialized: host.onMaterialized ? async (result) => host.onMaterialized?.([propertyEffect(result)]) : undefined,
  });
  return {
    kind: "updated",
    ref: host.mutationRef(
      saved.path,
      isPageID(saved.document?.frontmatter.id) ? saved.document.frontmatter.id : undefined,
      operation.ref.stableKey,
    ),
    contentRevision: saved.revision,
    propertiesRevision: saved.propertiesRevision ?? saved.revision,
    changedProperties,
    ...(!target && saved.kind === "directory" ? { directoryRevision: saved.revision } : {}),
  };
}
