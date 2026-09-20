import { semantic, same, type AccountConfigGraph } from "../../canopyd-merge/src/account.ts";
export * from "../../canopyd-merge/src/account.ts";

export function authorizeAccountConfigTransition(
  current: AccountConfigGraph,
  next: AccountConfigGraph,
  deviceID: string,
  changesFrom: AccountConfigGraph = current,
): void {
  if (!current.devices[deviceID]) throw new Error("Submitting device is not active in the accepted configuration");
  const administrator = current.account.admins.includes(deviceID);
  const acceptedSemantic = semantic(current) as any;
  const nextSemantic = semantic(next) as any;
  const baseSemantic = semantic(changesFrom) as any;
  const accountChangedBySubmitter = !same(baseSemantic.account, nextSemantic.account)
    && !same(acceptedSemantic.account, nextSemantic.account);
  const treesChangedBySubmitter = !same(baseSemantic.trees, nextSemantic.trees)
    && !same(acceptedSemantic.trees, nextSemantic.trees);
  if (!administrator && (accountChangedBySubmitter || treesChangedBySubmitter)) {
    throw new Error("Only an administrator may edit account.yaml or trees.yaml");
  }
  for (const id of new Set([...Object.keys(baseSemantic.devices), ...Object.keys(nextSemantic.devices)])) {
    if (id === deviceID) continue;
    const before = baseSemantic.devices[id];
    const after = nextSemantic.devices[id];
    if (same(after, acceptedSemantic.devices[id])) continue;
    if (before && !after && administrator) continue;
    if (!same(before, after)) throw new Error(`Device ${deviceID} may not edit devices/${id}.yaml`);
  }
  if (!next.account.admins.length || next.account.admins.some((id) => !next.devices[id])) {
    throw new Error("Administrators must remain a nonempty subset of active devices");
  }
}
