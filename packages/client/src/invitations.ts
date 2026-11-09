import { isMap, isScalar, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from "yaml";
import {
  buildInviteLocator,
  decodeProtocolDirectory,
  loadProtocolContent,
  generateInviteCode,
  HANDLE,
  inviteCodeDigest,
  parseMarkdown,
  type ProtocolClient,
} from "@ovst/protocol";
import { editTreeFile } from "./tree-file.ts";

/**
 * Invitations to a community (accounts §1.2), made by anyone who may write
 * its tree. An invitation is one `members` entry of the community root's
 * `_index.md` holding exactly `handle` and `inviteDigest`; the code itself is
 * only in the link, which is shown once. Each function edits the YAML source
 * so every other byte is kept, and refuses unless the parsed `members` list
 * comes out as the previous list with exactly that one invitation added,
 * removed or given a new digest.
 */

export interface Invitation {
  handle: string;
  /** The account URL, `https://<host>/~<handle>`: the link without its code. */
  account: string;
  /** The join link. It holds the code, so it is shown once and never stored. */
  link: string;
}

export interface PendingInvitation {
  handle: string;
  account: string;
}

export class InvitationError extends Error {
  override readonly name = "InvitationError";
}

interface CommunityContext {
  tree: string;
  origin: string;
}

async function community(client: ProtocolClient): Promise<CommunityContext> {
  const { account } = await client.anyAccount();
  const community = "community" in account ? account.community : undefined;
  if (!community) throw new InvitationError(`Invite people from ${new URL(client.origin).host} with an account whose home is there`);
  if (community.access !== "write") throw new InvitationError(`You may not invite people to ${new URL(client.origin).host}: only its community's administrators can`);
  return { tree: community.id, origin: new URL(client.origin).origin };
}

function checkHandle(handle: string): void {
  if (!HANDLE.test(handle)) throw new InvitationError(`${JSON.stringify(handle)} is not a handle: use lowercase letters, digits and hyphens`);
}

type RawMember = unknown;

/** The frontmatter's YAML body, where it starts in `source`, and its `members` list as parsed. */
function frontmatter(source: string): { body: string; start: number; members: RawMember[] } {
  const block = parseMarkdown(source).frontmatterSource;
  if (block === null) throw new InvitationError("The community's _index.md has no front matter to hold members");
  const start = block.indexOf("\n") + 1;
  const closing = block.replace(/\r?\n$/, "").lastIndexOf("\n") + 1;
  if (start <= 0 || closing < start) throw new InvitationError("The community's _index.md front matter is malformed");
  const declared = parseMarkdown(source).frontmatter.members;
  if (declared !== undefined && declared !== null && !Array.isArray(declared)) throw new InvitationError("The community's members field is not a list");
  return { body: block.slice(start, closing), start, members: Array.isArray(declared) ? declared : [] };
}

function invitationOf(member: RawMember): { handle: string; inviteDigest: string } | null {
  if (!member || typeof member !== "object" || Array.isArray(member)) return null;
  const record = member as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "handle" || keys[1] !== "inviteDigest") return null;
  return typeof record.handle === "string" && typeof record.inviteDigest === "string"
    ? { handle: record.handle, inviteDigest: record.inviteDigest } : null;
}

function handleOf(member: RawMember): string | null {
  return member && typeof member === "object" && !Array.isArray(member) && typeof (member as { handle?: unknown }).handle === "string"
    ? (member as { handle: string }).handle : null;
}

function sameJSON(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function newlineOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function lineStart(text: string, offset: number): number {
  return text.lastIndexOf("\n", offset - 1) + 1;
}

function lineEnd(text: string, offset: number): number {
  const end = text.indexOf("\n", offset);
  return end === -1 ? text.length : end + 1;
}

/** The `members` node of the frontmatter body, with its document. */
function membersNode(body: string): { node: unknown; key: { range?: [number, number, number] | null } | null } {
  const document = parseDocument(body);
  if (document.errors.length) throw new InvitationError("The community's _index.md front matter is not valid YAML");
  if (!isMap(document.contents)) throw new InvitationError("The community's _index.md front matter is not a map");
  const pair = (document.contents as YAMLMap).items.find((item) => isScalar(item.key) && item.key.value === "members");
  return { node: pair?.value ?? null, key: pair && isScalar(pair.key) ? pair.key as { range?: [number, number, number] | null } : null };
}

function entryText(handle: string, digest: string, flow: boolean, indent: string, newline: string): string {
  return flow
    ? `{ handle: ${JSON.stringify(handle)}, inviteDigest: ${JSON.stringify(digest)} }`
    : `${indent}- handle: ${JSON.stringify(handle)}${newline}${indent}  inviteDigest: ${JSON.stringify(digest)}${newline}`;
}

/** `body` with an invitation entry added at the end of `members`. */
function addEntry(body: string, handle: string, digest: string): string {
  const newline = newlineOf(body);
  const { node, key } = membersNode(body);
  if (isSeq(node)) {
    const seq = node as YAMLSeq;
    if (seq.flow) {
      if (!seq.range) throw new InvitationError("The community's members list can't be edited safely; use Story");
      const close = body.lastIndexOf("]", seq.range[1]);
      if (close < seq.range[0]) throw new InvitationError("The community's members list can't be edited safely; use Story");
      const text = `${seq.items.length ? ", " : ""}${entryText(handle, digest, true, "", newline)}`;
      return `${body.slice(0, close)}${text}${body.slice(close)}`;
    }
    const first = seq.items[0] as { range?: [number, number, number] | null } | undefined;
    const last = seq.items[seq.items.length - 1] as { range?: [number, number, number] | null } | undefined;
    if (!first?.range || !last?.range) throw new InvitationError("The community's members list can't be edited safely; use Story");
    const dash = body.lastIndexOf("-", first.range[0]);
    const indent = body.slice(lineStart(body, dash), dash);
    if (/\S/.test(indent)) throw new InvitationError("The community's members list can't be edited safely; use Story");
    const at = lineEnd(body, last.range[1] - 1 < 0 ? 0 : last.range[1] - 1);
    const before = body.slice(0, at);
    return `${before}${before.endsWith("\n") ? "" : newline}${entryText(handle, digest, false, indent, newline)}${body.slice(at)}`;
  }
  if (node === null || (isScalar(node) && (node as { value: unknown }).value === null)) {
    const entry = entryText(handle, digest, false, "  ", newline);
    if (key?.range) {
      // `members:` with nothing after it: the entry goes on the next lines.
      const at = lineEnd(body, key.range[0]);
      const before = body.slice(0, at);
      const rest = body.slice(at);
      if (!before.trimEnd().endsWith(":") && !/members:\s*(#.*)?\r?\n?$/.test(before)) throw new InvitationError("The community's members list can't be edited safely; use Story");
      return `${before}${before.endsWith("\n") ? "" : newline}${entry}${rest}`;
    }
    return `${body}${body === "" || body.endsWith("\n") ? "" : newline}members:${newline}${entry}`;
  }
  throw new InvitationError("The community's members field is not a list");
}

/** The source range of the one invitation entry for `handle`. */
function invitationNode(body: string, handle: string): { seq: YAMLSeq; entry: YAMLMap; index: number } {
  const { node } = membersNode(body);
  if (!isSeq(node)) throw new InvitationError(`No invitation for ~${handle} is pending`);
  const seq = node as YAMLSeq;
  const matches = seq.items.flatMap((item, index) => {
    if (!isMap(item)) return [];
    const map = item as YAMLMap;
    const keys = map.items.map((pair) => isScalar(pair.key) ? pair.key.value : null).sort();
    return keys.length === 2 && keys[0] === "handle" && keys[1] === "inviteDigest" && map.get("handle") === handle ? [{ entry: map, index }] : [];
  });
  if (matches.length !== 1) throw new InvitationError(`No invitation for ~${handle} is pending`);
  return { seq, ...matches[0]! };
}

function removeEntry(body: string, handle: string): string {
  const { seq, entry, index } = invitationNode(body, handle);
  if (!entry.range) throw new InvitationError("The community's members list can't be edited safely; use Story");
  if (seq.flow) {
    const [start, end] = entry.range;
    if (index > 0) {
      const comma = body.lastIndexOf(",", start);
      return `${body.slice(0, comma)}${body.slice(end)}`;
    }
    const after = /^\s*,\s*/.exec(body.slice(end));
    return `${body.slice(0, start)}${body.slice(end + (after ? after[0].length : 0))}`;
  }
  const dash = body.lastIndexOf("-", entry.range[0]);
  const from = lineStart(body, dash);
  if (/\S/.test(body.slice(from, dash))) throw new InvitationError("The community's members list can't be edited safely; use Story");
  const to = lineEnd(body, entry.range[1] - 1);
  return `${body.slice(0, from)}${body.slice(to)}`;
}

function replaceDigest(body: string, handle: string, digest: string): string {
  const { entry } = invitationNode(body, handle);
  const pair = entry.items.find((item) => isScalar(item.key) && item.key.value === "inviteDigest");
  const value = pair?.value;
  if (!isScalar(value) || !value.range) throw new InvitationError("The community's members list can't be edited safely; use Story");
  return `${body.slice(0, value.range[0])}${JSON.stringify(digest)}${body.slice(value.range[1])}`;
}

/**
 * Apply `edit` to the frontmatter of `source` and check the result: its
 * parsed `members` must equal `expected(previous)` exactly.
 */
function editMembers(source: string, edit: (body: string, members: RawMember[]) => string, expected: (members: RawMember[]) => RawMember[]): string {
  const { body, start, members } = frontmatter(source);
  const edited = edit(body, members);
  const result = `${source.slice(0, start)}${edited}${source.slice(start + body.length)}`;
  const after = frontmatter(result).members;
  if (!sameJSON(after, expected(members))) throw new InvitationError("The community's members list can't be edited safely; use Story");
  return result;
}

/** A community `_index.md` with an invitation for `handle` added to `members`. */
export function withInvitation(source: string, handle: string, digest: string): string {
  checkHandle(handle);
  return editMembers(
    source,
    (body, members) => {
      const taken = members.find((member) => handleOf(member) === handle);
      if (taken) throw new InvitationError(invitationOf(taken) ? `~${handle} already has a pending invitation; use \`story invite renew\` for a new link` : `~${handle} is already a member`);
      return addEntry(body, handle, digest);
    },
    (members) => [...members, { handle, inviteDigest: digest }],
  );
}

/** A community `_index.md` with `handle`'s pending invitation given `digest`. */
export function withRenewedInvitation(source: string, handle: string, digest: string): string {
  return editMembers(
    source,
    (body) => replaceDigest(body, handle, digest),
    (members) => members.map((member) => invitationOf(member)?.handle === handle ? { ...(member as object), inviteDigest: digest } : member),
  );
}

/** A community `_index.md` without `handle`'s pending invitation. */
export function withoutInvitation(source: string, handle: string): string {
  return editMembers(
    source,
    (body) => removeEntry(body, handle),
    (members) => members.filter((member) => invitationOf(member)?.handle !== handle),
  );
}

const INDEX = "_index.md";

/** Reserve `handle` in the caller's community and return its join link. */
export async function createInvitation(client: ProtocolClient, handle: string): Promise<Invitation> {
  checkHandle(handle);
  const { tree, origin } = await community(client);
  const code = generateInviteCode();
  const digest = inviteCodeDigest(code);
  await editTreeFile(client, tree, INDEX, (source) => withInvitation(source, handle, digest));
  const account = `${origin}/~${handle}`;
  return { handle, account, link: buildInviteLocator(account, code) };
}

/** The community's pending invitations, by handle. */
export async function pendingInvitations(client: ProtocolClient): Promise<PendingInvitation[]> {
  const { tree, origin } = await community(client);
  const head = (await client.descriptor(tree)).tree;
  const snapshot = await client.snapshot(tree, head.root);
  const root = decodeProtocolDirectory(snapshot.objects.get(head.root)!);
  if (root.type !== "directory") return [];
  const index = root.entries.find((entry) => entry.name === INDEX);
  if (!index) return [];
  const source = new TextDecoder().decode(await loadProtocolContent(index, async (hash) => snapshot.objects.get(hash)!));
  const declared = parseMarkdown(source).frontmatter.members;
  return (Array.isArray(declared) ? declared : []).flatMap((member) => {
    const invitation = invitationOf(member);
    return invitation ? [{ handle: invitation.handle, account: `${origin}/~${invitation.handle}` }] : [];
  });
}

/** Give `handle`'s pending invitation a new code: the old link stops working. */
export async function renewInvitation(client: ProtocolClient, handle: string): Promise<Invitation> {
  checkHandle(handle);
  const { tree, origin } = await community(client);
  const code = generateInviteCode();
  const digest = inviteCodeDigest(code);
  await editTreeFile(client, tree, INDEX, (source) => withRenewedInvitation(source, handle, digest));
  const account = `${origin}/~${handle}`;
  return { handle, account, link: buildInviteLocator(account, code) };
}

/** Withdraw `handle`'s pending invitation. */
export async function cancelInvitation(client: ProtocolClient, handle: string): Promise<void> {
  checkHandle(handle);
  const { tree } = await community(client);
  await editTreeFile(client, tree, INDEX, (source) => withoutInvitation(source, handle));
}
