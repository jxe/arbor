import type { TreeKind } from "@ovst/protocol";
import type { ObjectHash } from "@ovst/protocol";

export interface HostTree {
  id: string;
  canonicalPath: string | null;
  parentTree: string | null;
  kind: TreeKind;
  ref: ObjectHash;
  /** For a tree configuration, the TreeID of the tree it configures. */
  governs: string | null;
}

/**
 * A host account: this profile is claimed here, with this handle. Its identity
 * is the pair of host and profile, so `id` is the profile TreeID.
 */
export interface HostAccount {
  id: string;
  handle: string;
  enabled: boolean;
  /** For a placement account, the origin of the profile's home host, whose
   * published device keys this host reads (accounts §1.3); null when this
   * host is the profile's home. */
  homeHost: string | null;
}

/** A request a key device's session authenticated: the only kind (accounts §5). */
export interface HostAuthentication {
  account: HostAccount;
  device: string;
  /** The subject its updates are recorded under: `device:<DeviceID>`. */
  subject: `device:${string}`;
  /** The session's expiry. */
  expiresAt: number;
}
