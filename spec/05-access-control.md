# Access control
*Part of the [Arbor spec](../spec.md): who may read, write, or invoke reviewed mutations for a tree, how a request proves who it is, and what a hash does not authorize.*

*Owns: access subjects, rules, levels, and named mutation permissions; authentication headers and secret handling; tree-scoped authorization; and the `access` route. References: [accounts and devices](04-accounts-and-devices.md) for the `trees.yaml` that carries rules and `devices.yaml` whose entries govern account-scoped credentials, and [executable documents](07-executable-documents.md) for reviewed named mutations.*

## 1. Subjects and rules

```ts
type ReadWriteAccess = "read" | "write";
type MutationPermission = string;

type AccessSubject =
  | { kind: "everyone" }
  | { kind: "profile"; tree: TreeID }
  | { kind: "link"; digest: Hash };

type AccessRule = {
  subject: AccessSubject;
  access: ReadWriteAccess;
  permissions?: MutationPermission[];
};

type SafeAccessSubject =
  | { kind: "everyone" }
  | { kind: "profile"; tree: TreeID; locator?: string }
  | { kind: "link" };

type AccessEntry = {
  id: string;
  subject: SafeAccessSubject;
  access: ReadWriteAccess;
  permissions?: MutationPermission[];
};
```

`AccessRule` is the submitted and stored form; `AccessEntry` is the safe
administrative form, and a `SafeAccessSubject` never carries a link digest or
secret.

Access subjects are `everyone`, a stable profile `TreeID`, or a
`sha256:<hex>` access-link digest. Every stored rule contains `read` or
`write`; `none` means removal and is never stored. A rule may additionally
carry an ordered, duplicate-free list of mutation permissions. An omitted
`permissions` field means an empty list. A permission is a lower-case ASCII
identifier matching `[a-z][a-z0-9-]*`, with `none`, `read`, and `write`
reserved. Permission identity is scoped by the tree whose executable mutation
declares it; the same spelling in another tree is unrelated.

Public access is represented by the `everyone` rule; there is no
`publicAccess` field. A `write` rule permits updates under either `ifMatch` and
satisfies every tree-local mutation permission. A narrower grant limited to
`modelHash` is deferred ([deferred 10](../spec.md#deferred)). A raw link secret
never enters YAML.

Rules live in the account's `trees.yaml` ([accounts §3](04-accounts-and-devices.md#3-configuration-yaml));
an administrator changes them by editing that file, and the server applies the
change atomically with the accepted configuration root
([accounts §7](04-accounts-and-devices.md#7-governed-account-tree)).
Group membership is authored profile content and does not itself grant access.

### 1.1 Named mutation permissions

A mutation permission authorizes invocation of reviewed named mutations that
declare that permission. It does not authorize an accepted tree update, direct
node or backing writes, another mutation permission, external effects, or
access to any unreadable tree. In the initial contract every subject with a
mutation permission also has `read` or `write`; blind mutation submission
without read access is not defined.

Executable source declares a stable permission name, human title, and concise
description, and each named mutation declares exactly one requirement. A
mutation with no explicit requirement requires `write`, preserving the default
for existing authored source. The compiler records permission definitions,
per-handle requirements, and resolved write prefixes in the reviewed manifest.
An ACL reference to a permission absent from the active manifest is inert and
diagnosable rather than an authorization grant.

Authorization has three cumulative boundaries:

1. the caller must have effective read access and either `write` or the named
   permission required by the mutation;
2. the active reviewed manifest confines the mutation to its declared trees,
   transaction domain, write prefixes, and operations; and
3. data-dependent checks such as authorship, ownership, or current workflow
   state occur inside the mutation transaction.

An ACL permission is therefore coarse authority to invoke a class of reviewed
operations, not a replacement for row- or input-dependent authorization. The
host rechecks it on every call before entering the transaction. External
effects remain governed by their separate effect and consent contract; full
tree `write` does not imply them.

## 2. Authentication and secrets

Authenticated requests use:

```text
Authorization: Bearer <device credential>
Arbor-Access-Link: <access-link secret>
```

The server stores only cryptographic digests. Across all valid presented
subjects it grants the maximum `none`/`read`/`write` level and the union of
their mutation permissions; `write` satisfies all tree-local mutation
permissions. Tree descriptors expose that effective base level and the
sorted, duplicate-free effective list of permissions declared by the active
manifest; they omit inert names and do not enumerate the permissions implied
by `write`. Administrative access entries still expose stored inert names so
an administrator can diagnose or remove them. Raw credentials, profile private
keys, and link secrets never appear
in URLs, redirects, response bodies, errors, logs, refs, objects, YAML, access
lists, or events. Link entries returned to administrators reveal neither secret
nor digest.

An accepted device credential authenticates one device in one Canopy account.
For profile-subject access, it contributes exactly that account's
`account.yaml.profile` TreeID. The server never infers a profile subject from
the Canopy origin, account handle, canonical profile URL, or a device identity.
One physical installation paired with several accounts therefore presents the
credential for the account through which it is acting.

## 3. Tree-scoped authorization

Possession of a hash is not authorization. Every object or snapshot read is
scoped through one named tree and its current ACL.

The generic object route additionally requires reachability from the named
tree's current root. The accepted-snapshot route instead requires that its root
belong to one of the named tree's retained accepted updates. It deliberately
provides non-enumerable known-root historical reads: the server exposes neither
a history listing nor accepted-update metadata, and unknown, unretained,
wrong-tree, and unauthorized roots are indistinguishable `404`s.

Deleting content from the current root does not erase it from a retained
accepted snapshot. Revoking a subject prevents later authorized origin fetches
but cannot retract bytes already received. A response admitted to a shared
public cache while the tree is readable by `everyone` can therefore outlive a
later ACL change.

A nested tree entry is a boundary, not an object copy. Parent reachability stops
there and the child's root, objects, history, and ACL remain independent.

## 4. Reading access

```text
GET /.arbor/trees/{TreeID}/access
```

The response is a snapshot envelope of safe `AccessEntry`s, including each
entry's named mutation permissions. Steady-state ACL
mutation occurs by editing the authenticated account's `trees.yaml`; there is
no separate access-mutation endpoint. Rule subjects, levels, and the `none`
removal rule are defined once in
[§1](#1-subjects-and-rules). An access-link secret
is generated and shown locally once; only its digest is submitted in
configuration, and a safe entry exposes neither.
