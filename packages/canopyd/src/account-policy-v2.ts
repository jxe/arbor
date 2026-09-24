import { semantic, same, type AccountConfigGraphV2 } from "../../canopyd-merge/src/account-v2.ts";
import { PermissionDeniedError } from "./errors.ts";
export * from "../../canopyd-merge/src/account-v2.ts";

export function authorizeAccountConfigTransitionV2(
  current: AccountConfigGraphV2,
  next: AccountConfigGraphV2,
  deviceID: string,
  changesFrom: AccountConfigGraphV2 = current,
  resourceFormat = !!current.resources,
): void {
  if (resourceFormat && !next.resources && Object.values(next.trees).some(tree => tree.access.length)) {
    throw new PermissionDeniedError("Legacy policy writes are not allowed after resource-policy conversion");
  }
  const currentDevice = current.devices[deviceID];
  if (!currentDevice) throw new PermissionDeniedError("Submitting device is not active in the accepted configuration");
  const accepted = semantic(current);
  const base = semantic(changesFrom);
  const candidate = semantic(next);
  if (!same(base.account, candidate.account) && !same(accepted.account, candidate.account)) {
    throw new Error("account.yaml changes require an account lifecycle transition");
  }
  if (!currentDevice.administrator && (!same(base.trees, candidate.trees) || !same(base.resources, candidate.resources)) && (!same(accepted.trees, candidate.trees) || !same(accepted.resources, candidate.resources))) {
    throw new PermissionDeniedError("Only an administrator may edit trees.yaml");
  }
  for (const id of new Set([...Object.keys(base.devices), ...Object.keys(candidate.devices)])) {
    const before = base.devices[id];
    const after = candidate.devices[id];
    if (same(after, accepted.devices[id])) continue;
    if (currentDevice.administrator) continue;
    if (id !== deviceID || !before || !after || before.administrator !== after.administrator) {
      throw new Error(`Device ${deviceID} may change only its own label`);
    }
    if (before.label === after.label) throw new Error(`Device ${deviceID} may change only its own label`);
  }
  if (!Object.values(next.devices).some((device) => device.administrator)) {
    throw new Error("At least one administrator must remain active");
  }
}
