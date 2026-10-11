# Security 012: Get back into an account with the admin's help

**Why and when:** Joe wants a person who has lost their Mac, or every device, to get back into their account without knowing what a pairing code or an operator is. On 2026-10-11 he decided the host's administrator stays involved, as the spec has it, and that the thing to maximize is how easy it is for both people. Today the administrator must run a command on the server and pass a code by hand. Do this before people depend on Story enough to lose a Mac.

Formerly "Rejoin an account with the profile key". That plan asked whether the profile key alone may enrol a device; the answer is no (below), and its sketch of a signed enrolment is in this file's git history.

## Status

- **Effort**: M
- **Risk**: MEDIUM. An administrator of the host gains, in the app, a power only the operator's shell had: replacing a member's devices.
- **Depends on**: nothing. Step 3 is easier after [Sharing 001](../sharing/001-join-on-iphone-first.md), which gives the iPhone a join screen.
- **Category**: security, product completion

## Decided

- **The profile key does not enrol a device.** Accounts §1.1 stays: the key claims accounts and does not recover lost devices. A stolen backup, with its passphrase if it has one, still cannot get into an account without a paired device or the administrator. The passphrase became optional on 2026-10-11, which is one more reason to keep this.
- **Recovery stays a person's decision** (accounts §5.3). What changes is who can make it and how: an administrator of the host, in Story, not only whoever has a shell on the server.

## What exists

- `overstoryd recover <handle>` prints a recovery pairing code, valid for a day. Claiming it leaves the new device as the account's only device, an administrator, and revokes every earlier one (accounts §5.3). On the live host it is run over `railway ssh`.
- A person who still has one working device needs none of this: that device shows a pairing code and the new one claims it.
- The Mac setup form answers "already claimed" with a line pointing at **I've used Story before**, which takes a pairing code of either kind (`StoryOnboarding.swift`). Nothing tells the person whom to ask, or what to ask for.
- An identity backup restores the profile key on a new Mac. It proves who is asking; it opens nothing.
- A host names its administrators one by one (2026-10-10), and Story's People list has a member sheet for each person.

## What friendly means here

The person never sees the words recovery pairing, and never copies a code if a link will do. The administrator decides with one tap, from a request that says who is asking and whether the host could verify it. Neither of them opens a terminal.

## Design

1. **The administrator can let someone back in, from Story.** The member sheet gains **Help them get back in…**. It explains in one sentence that their old devices will stop working, then makes a link, shown with Copy and Share like an invitation link: the person's address on the host with a `#overstory-recover=<code>` fragment. Opened on a Mac, or pasted into the setup form, it goes straight to "Welcome back, ~handle" and into the first steps. The host route behind it is the pairing-offer route with `recovery: true`, allowed to the host's administrators for accounts on that host; `overstoryd recover` keeps working and prints the same link.
2. **The person can ask, from the new Mac.** When a join answers "already claimed", the form says so plainly and offers **Ask ~admin to let me back in**. With the identity restored from a backup, the request is signed by the profile key, so the administrator sees "~maya is asking to get back in from Maya's MacBook. Verified with her identity backup." Without it, the request says it could not be verified, and the administrator is told to check with the person another way first. The Mac waits on that screen and continues by itself when the request is approved; nothing is sent back by hand.
3. **The administrator hears about it.** A pending request shows on the People list and in the member sheet, with Approve and Decline. Approving is step 1 without the link. A request expires after a day, and a host keeps at most one per account.
4. **Say what happened to the old devices.** After a recovery the new device's first screen says its other devices were signed out and offers the pairing code to bring an iPhone back.

Step 1 alone removes the terminal and can ship first. Steps 2 and 3 remove the need to reach the administrator out of band.

## Open

- **Who may approve.** Any administrator of the host, or only those the host names for it. Start with any administrator; a host with one administrator has no one to ask but them.
- **An administrator who loses everything.** Another administrator can help; a sole administrator still needs the server's shell. Say so in the deployment guide rather than build around it.
- **Whether an unverified request may be made at all.** It lets anyone who knows a handle put a prompt in front of the administrator. Either require the restored identity for step 2, or rate-limit per handle and address. Joe's limits are opt-in, so the first is the default.
- **Whether a verified request could skip the wipe.** The recovery pairing replaces every device because it assumes they are all lost. A person who only wants to add a Mac and has a working iPhone should be steered to pairing instead; the form can ask "Do you still have Story on another device?" first.

## Steps

1. **Spec.** Accounts §5.3: an administrator of the host may issue a recovery pairing; the recovery link form; the optional signed request and what the host stores for it. Access control: which rule lets an administrator do it. Conformance vectors for the link and the request.
2. **Host.** Recovery by an administrator through the pairing-offer route; the request routes (make, list for administrators, approve, decline); tests for a non-administrator, a wrong profile signature, a replayed request, a second request for one account and an expired one.
3. **Story on the Mac.** The member sheet action and the link; the "already claimed" screen with the question about another device, the request, and the wait; the People list's pending requests. Then the iPhone, once it has a join screen.
4. **Check by hand** with two Macs and a disposable host: recover by link, recover by a verified request, decline one, and confirm the old Mac is signed out and says why.
5. **Close out.** Update `packages/overstoryd/deploy/README.md` (recovery no longer needs `railway ssh`), record the evidence in `status.md` and delete this plan.

Gate: `bun run test:affected`, `bun run test:protocol`, `swift/scripts/test-story-app.sh`. Deploying is pushing main; trying it against the live host waits for Joe's go-ahead.

## Related

- [Security 010](../security/010-signed-profile-statements.md)'s first decision is the same question once a host Joe does not run is involved. This plan answers it for hosts whose administrators are trusted.
- [Sharing 001](../sharing/001-join-on-iphone-first.md): a phone-first person who loses the phone restores the backup on a new one and asks the same way.
