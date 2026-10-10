import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeProtocolDirectory, type ProtocolClient } from "@ovst/protocol";
import { resolveSnapshot, snapshotDirectory } from "@ovst/fs";
import { editTreeConfig } from "./tree-config.ts";

/**
 * Reserve handles on a host's community, as its owner (a community writer):
 * each for a Profile TreeID this host holds, or for a profile another host
 * holds, by its locator there, which makes it a placement account
 * (accounts §1.3). Every tree the community root mounts keeps its entry; only
 * `_index.md` changes. `scratch` is a directory to write the new root in.
 */
export async function reserveMembers(owner: ProtocolClient, scratch: string, members: Record<string, string>): Promise<void> {
  const account = await owner.account();
  const community = await owner.descriptor(account.account.community.id);
  const source = join(scratch, `community-${crypto.randomUUID()}`);
  await mkdir(source, { recursive: true });
  const lines = ["---", "type: group", "members:",
    "  -", `    profile: "overstory://${account.account.profileTree!}/"`, `    handle: "${account.account.handle ?? "owner"}"`,
    ...Object.entries(members).flatMap(([handle, profile]) => ["  -", `    profile: "${profile.startsWith("tr_") ? `overstory://${profile}/` : profile}"`, `    handle: "${handle}"`]),
    "---", "", "# Community", ""];
  await writeFile(join(source, "_index.md"), lines.join("\n"));
  const head = await owner.snapshot(community.tree.id, community.tree.root);
  const mounted = decodeProtocolDirectory(head.objects.get(head.root)!).entries.flatMap((entry) =>
    entry.tree ? [[join(source, entry.name), entry.tree] as [string, string]] : []);
  const next = await resolveSnapshot(await snapshotDirectory(source, new Map(mounted)));
  await owner.submitUpdate(community.tree.id, community.tree.update, next);
}

/** Let anyone read a person's profile, so another host can resolve its locator. */
export async function makeProfilePublic(client: ProtocolClient, profileTree: string): Promise<void> {
  await editTreeConfig(client, profileTree, "person", (values) => ({
    ...values,
    access: values.access.some((rule) => rule.who === "everyone") ? values.access : [...values.access, { who: "everyone", allow: ["read"] }],
  }));
}
