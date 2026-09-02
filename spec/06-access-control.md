# Access control
*Part of the [Arbor spec](../spec.md): who may read or write a tree, how a request proves who it is, and what a hash does not authorize.*

*Owns: access subjects, rules, and levels; authentication headers and secret handling; tree-scoped authorization; and the `access` route. References: [accounts and devices](05-accounts-and-devices.md) for the `trees.yaml` that carries rules and the device files that carry credentials.*

## 1. Subjects and rules

```ts
type AccessSubject =
  | { kind: "everyone" }
  | { kind: "profile"; tree: TreeID }
  | { kind: "link"; digest: Hash };

type AccessRule = { subject: AccessSubject; access: ReadWriteAccess };

type SafeAccessSubject =
  | { kind: "everyone" }
  | { kind: "profile"; tree: TreeID; locator?: string }
  | { kind: "link" };

type AccessEntry = {
  id: string;
  subject: SafeAccessSubject;
  access: ReadWriteAccess;
};
```

`AccessRule` is the submitted and stored form; `AccessEntry` is the safe
administrative form, and a `SafeAccessSubject` never carries a link digest or
secret.

Access subjects are `everyone`, a stable profile `TreeID`, or a
`sha256:<hex>` access-link digest. Stored rules contain only `read` or `write`;
`none` means removal and is never stored. Public access is represented by the
`everyone` rule; there is no `publicAccess` field. A `write` rule permits
updates under either `ifMatch`; a narrower grant limited to `modelHash` is
deferred ([deferred 10](../spec.md#deferred)). A raw link secret never
enters YAML.

Rules live in the account's `trees.yaml` ([accounts §3](05-accounts-and-devices.md#3-configuration-yaml));
an administrator changes them by editing that file, and the server applies the
change atomically with the accepted configuration root
([accounts §6](05-accounts-and-devices.md#6-governed-account-tree)).
Group membership is authored profile content and does not itself grant access.

## 2. Authentication and secrets

Authenticated requests use:

```text
Authorization: Bearer <device credential>
Arbor-Access-Link: <access-link secret>
```

The server stores only cryptographic digests and grants the maximum access
of all valid presented subjects. Raw credentials and link secrets never appear
in URLs, redirects, response bodies, errors, logs, refs, objects, YAML, access
lists, or events. Link entries returned to administrators reveal neither secret
nor digest.

## 3. Tree-scoped authorization

Possession of a hash is not authorization. The server checks reachability from
the named tree's current readable root; retained accepted history does not
create historical-object access, and the server must not scan every readable
root.

A nested tree entry is a boundary, not an object copy. Parent reachability stops
there and the child's root, objects, history, and ACL remain independent.

## 4. Reading access

```text
GET /.arbor/trees/{TreeID}/access
```

The response is a snapshot envelope of safe `AccessEntry`s. Steady-state ACL
mutation occurs by editing the authenticated account's `trees.yaml`; there is
no separate access-mutation endpoint. Rule subjects, levels, and the `none`
removal rule are defined once in
[§1](#1-subjects-and-rules). An access-link secret
is generated and shown locally once; only its digest is submitted in
configuration, and a safe entry exposes neither.
