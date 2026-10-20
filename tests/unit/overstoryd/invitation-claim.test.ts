import { describe, expect, test } from "bun:test";
import { parseMarkdown } from "@ovst/protocol";
import { claimInvitationEntry } from "../../../packages/overstoryd/src/invitation-claim.ts";
import { structuredMembers } from "../../../packages/overstoryd/src/profile.ts";

const handle = "guest";
const digest = `sha256:${"ab".repeat(32)}`;
const profileTree = "tr_abcdefghijklmnopqrstuvwxyz";
const profile = `overstory://${profileTree}/`;
const other = "overstory://tr_zyxwvutsrqponmlkjihgfedcba/";

const members = (source: string) => structuredMembers(parseMarkdown(source).frontmatter.members);

/** A community index whose `members` list is `list`, with authored text around it. */
const index = (list: string, newline = "\n") =>
  ["---", "type: group", `displayName: "Garden"  # the name`, ...list.split("\n"), "---", "", "# Garden", "", "handle: guest stays in the body", ""].join(newline);

/** The claim must change exactly the entry: `before` with `removed` swapped for `inserted`. */
function expectClaim(before: string, removed: string, inserted: string) {
  expect(before.split(removed)).toHaveLength(2);
  // The profile reader sees the pending entry in this layout to begin with.
  expect(members(before)).toContainEqual({ handle, inviteDigest: digest });
  const claimed = claimInvitationEntry(before, handle, digest, profile);
  expect(claimed).toBe(before.replace(removed, inserted));
  expect(members(claimed!)).toContainEqual({ profile, handle });
  expect(members(claimed!).length).toBe(members(before).length);
  expect(claimed).not.toContain(digest);
}

describe("claiming a pending invitation entry", () => {
  test("block style, keys in either order", () => {
    expectClaim(
      index(`members:\n  - profile: "${other}"\n    handle: owner\n  - handle: "guest"\n    inviteDigest: "${digest}"`),
      `handle: "guest"\n    inviteDigest: "${digest}"`,
      `profile: "${profile}"\n    handle: "guest"`,
    );
    expectClaim(
      index(`members:\n  - inviteDigest: ${digest}\n    handle: guest\n  - profile: "${other}"`),
      `inviteDigest: ${digest}\n    handle: guest`,
      `profile: "${profile}"\n    handle: "guest"`,
    );
  });

  test("a dash on its own line, and an unindented list", () => {
    expectClaim(
      index(`members:\n  -\n    handle: guest\n    inviteDigest: ${digest}\n  -\n    profile: "${other}"`),
      `handle: guest\n    inviteDigest: ${digest}`,
      `profile: "${profile}"\n    handle: "guest"`,
    );
    expectClaim(
      index(`members:\n- handle: guest\n  inviteDigest: ${digest}\n- profile: "${other}"`),
      `handle: guest\n  inviteDigest: ${digest}`,
      `profile: "${profile}"\n  handle: "guest"`,
    );
  });

  test("a flow-style map, in a block list or a flow list", () => {
    expectClaim(
      index(`members:\n  - { handle: guest, inviteDigest: "${digest}" }\n  - { profile: "${other}" }`),
      `{ handle: guest, inviteDigest: "${digest}" }`,
      `{ profile: "${profile}", handle: "guest" }`,
    );
    expectClaim(
      index(`members: [{profile: "${other}"}, {inviteDigest: ${digest}, handle: guest}]`),
      `{inviteDigest: ${digest}, handle: guest}`,
      `{ profile: "${profile}", handle: "guest" }`,
    );
  });

  test("single-quoted, double-quoted and plain values", () => {
    for (const [name, value] of [[`'guest'`, `'${digest}'`], [`"guest"`, digest], [`guest`, `"${digest}"`]] as const) {
      expectClaim(
        index(`members:\n  - handle: ${name}\n    inviteDigest: ${value}`),
        `handle: ${name}\n    inviteDigest: ${value}`,
        `profile: "${profile}"\n    handle: "guest"`,
      );
    }
  });

  test("CRLF line endings are kept", () => {
    const before = index(`members:\n  - profile: "${other}"\n  - handle: guest\n    inviteDigest: ${digest}`, "\r\n");
    expect(before).not.toMatch(/[^\r]\n/);
    expectClaim(before, `handle: guest\r\n    inviteDigest: ${digest}`, `profile: "${profile}"\r\n    handle: "guest"`);
    expect(claimInvitationEntry(before, handle, digest, profile)).not.toMatch(/[^\r]\n/);
  });

  test("comments between entries, and after the entry's own values, are kept", () => {
    expectClaim(
      index(`members:\n  # the founder\n  - profile: "${other}"\n\n  # invited in October\n  - handle: guest  # their name\n    inviteDigest: ${digest}  # expires soon\n  # more to come`),
      `handle: guest  # their name\n    inviteDigest: ${digest}`,
      `profile: "${profile}"\n    handle: "guest"`,
    );
  });

  test("a document with no trailing newline after the closing marker", () => {
    const before = `---\ntype: group\nmembers:\n  - handle: guest\n    inviteDigest: ${digest}\n---`;
    expect(claimInvitationEntry(before, handle, digest, profile)).toBe(`---\ntype: group\nmembers:\n  - profile: "${profile}"\n    handle: "guest"\n---`);
  });

  test("a duplicate entry is refused, in any mix of layouts", () => {
    expect(claimInvitationEntry(index(`members:\n  - handle: guest\n    inviteDigest: ${digest}\n  - handle: guest\n    inviteDigest: ${digest}`), handle, digest, profile)).toBeNull();
    expect(claimInvitationEntry(index(`members:\n  - handle: guest\n    inviteDigest: ${digest}\n  - { inviteDigest: "${digest}", handle: 'guest' }`), handle, digest, profile)).toBeNull();
  });

  test("anything that is not exactly this invitation is refused", () => {
    const refused = [
      index(`members:\n  - profile: "${other}"`),
      index(`members:\n  - handle: guest\n    inviteDigest: sha256:${"cd".repeat(32)}`),
      index(`members:\n  - handle: someone-else\n    inviteDigest: ${digest}`),
      // An extra key makes it a different entry, which the profile reader ignores too.
      index(`members:\n  - handle: guest\n    inviteDigest: ${digest}\n    note: hello`),
      index(`members:\n  - handle: guest`),
      index(`members: guest`),
      index(`type: person`),
      // Broken YAML, a repeated key, and no frontmatter at all.
      index(`members:\n  - handle: guest\n   inviteDigest: ${digest}\n  : :`),
      index(`members:\n  - handle: guest\n    handle: guest\n    inviteDigest: ${digest}`),
      `# Garden\n\nmembers:\n  - handle: guest\n    inviteDigest: ${digest}\n`,
      `---\nmembers:\n  - handle: guest\n    inviteDigest: ${digest}\n`,
    ];
    for (const source of refused) expect(claimInvitationEntry(source, handle, digest, profile), source).toBeNull();
  });

  test("the entry is matched by value, not by text elsewhere in the document", () => {
    const before = index(`description: "handle: guest inviteDigest: ${digest}"\nmembers:\n  - handle: guest\n    inviteDigest: ${digest}`);
    const claimed = claimInvitationEntry(before, handle, digest, profile)!;
    expect(claimed).toContain(`description: "handle: guest inviteDigest: ${digest}"`);
    expect(claimed).toContain(`  - profile: "${profile}"\n    handle: "guest"\n---`);
    expect(claimed.endsWith("handle: guest stays in the body\n")).toBe(true);
  });
});
