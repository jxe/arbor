import { describe, expect, test } from "bun:test";
import { parseMarkdown } from "@ovst/protocol";
import { withInvitation, withoutInvitation, withRenewedInvitation } from "@ovst/client";

const digest = `sha256:${"a".repeat(64)}`;
const renewed = `sha256:${"b".repeat(64)}`;
const owner = { profile: "overstory://tr_aaaaaaaaaaaaaaaaaaaaaaaaaa/", handle: "owner" };
const page = (frontmatter: string) => `---\ntype: group\n${frontmatter}---\n\n# Garden\n`;
const members = (source: string) => parseMarkdown(source).frontmatter.members ?? [];

const layouts: Array<[string, string]> = [
  ["block", `members:\n  - profile: "${owner.profile}"\n    handle: owner\n`],
  ["block at column 0", `members:\n- profile: "${owner.profile}"\n  handle: owner\n`],
  ["block with comments", `members:\n  # founders\n  - profile: "${owner.profile}"  # first\n    handle: owner\n  # end of list\ntitle: Garden\n`],
  ["flow", `members: [{ profile: "${owner.profile}", handle: owner }]\n`],
  ["empty flow", "members: []\n"],
  ["empty", "members:\ntitle: Garden\n"],
  ["absent", "title: Garden\n"],
];

describe("invitation entries", () => {
  for (const [name, frontmatter] of layouts) {
    for (const crlf of [false, true]) {
      test(`${name}${crlf ? ", CRLF" : ""}: added, renewed and removed, keeping every other byte`, () => {
        const source = crlf ? page(frontmatter).replaceAll("\n", "\r\n") : page(frontmatter);
        const before = members(source) as unknown[];
        const invited = withInvitation(source, "dana", digest);
        expect(members(invited)).toEqual([...before, { handle: "dana", inviteDigest: digest }]);
        for (const comment of ["# founders", "# first", "# end of list"]) if (source.includes(comment)) expect(invited).toContain(comment);
        if (crlf) expect(invited.replaceAll("\r\n", "")).not.toContain("\n");
        const again = withRenewedInvitation(invited, "dana", renewed);
        expect(members(again)).toEqual([...before, { handle: "dana", inviteDigest: renewed }]);
        const removed = withoutInvitation(again, "dana");
        expect(members(removed)).toEqual(before);
        if (before.length) expect(removed).toBe(source);
      });
    }
  }

  test("refuses a handle already used, a bad handle, and a missing invitation", () => {
    const source = page(layouts[0]![1]);
    expect(() => withInvitation(source, "owner", digest)).toThrow("already a member");
    expect(() => withInvitation(withInvitation(source, "dana", digest), "dana", renewed)).toThrow("already has a pending invitation");
    expect(() => withInvitation(source, "Dana!", digest)).toThrow("is not a handle");
    expect(() => withoutInvitation(source, "dana")).toThrow("No invitation for ~dana is pending");
    expect(() => withoutInvitation(source, "owner")).toThrow("No invitation for ~owner is pending");
  });

  test("refuses a members field that is not a list, and a page without front matter", () => {
    expect(() => withInvitation(page("members: everyone\n"), "dana", digest)).toThrow("not a list");
    expect(() => withInvitation("# Garden\n", "dana", digest)).toThrow("no front matter");
  });
});
