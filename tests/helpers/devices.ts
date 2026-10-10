import { createHash, createPrivateKey, sign } from "node:crypto";
import type { HostBootstrapAccount, HostDaemon } from "@ovst/overstoryd";
import {
  deviceKeyFromSeed,
  deviceSessionChallengeBytes,
  encodeBase32,
  openDeviceSession,
  ProtocolClient,
} from "@ovst/protocol";

/**
 * A key device for tests, derived from a name: the same name always gives the
 * same profile TreeID, DeviceID and Ed25519 key, so a test names its device
 * where it once named a bearer credential, and hosts, clients and data homes
 * agree on it without passing anything else around.
 */
export interface TestDevice {
  name: string;
  profileTree: string;
  device: string;
  seed: string;
  key: string;
}

const derived = (name: string, purpose: string) => createHash("sha256").update(`story-test-device\0${purpose}\0${name}`).digest();

export function testDevice(name: string): TestDevice {
  const seed = derived(name, "seed").toString("base64url");
  return {
    name,
    profileTree: `tr_${encodeBase32(derived(name, "profile").subarray(0, 16))}`,
    device: `dv_${encodeBase32(derived(name, "device").subarray(0, 16))}`,
    seed,
    key: deviceKeyFromSeed(seed),
  };
}

/** A bootstrap account whose profile and first device are `testDevice(name)`. */
export function testAccount(
  handle: string,
  name: string,
  options: Omit<HostBootstrapAccount, "handle" | "profileTree" | "device"> = {},
): HostBootstrapAccount {
  const { profileTree, device, key } = testDevice(name);
  return { handle, profileTree, device: { id: device, key }, ...options };
}

/** A new DeviceID and key for a device a test pairs or enrolls, with the name that derives it. */
export function newTestDevice(label = "device"): TestDevice {
  return testDevice(`${label}-${crypto.randomUUID()}`);
}

/** Sessions already opened, by host and device, so a test's many clients share one challenge. */
const sessions = new Map<string, { token: string; expiresAt: number }>();

/**
 * A session token for `testDevice(name)` at `origin`: the bearer token a
 * device presents, where a test once presented its credential. `profileTree`
 * overrides the derived one for a device paired into another profile.
 */
export async function deviceSession(origin: string, name: string, profileTree?: string): Promise<string> {
  const device = testDevice(name);
  const key = `${new URL(origin).origin}\0${profileTree ?? device.profileTree}\0${device.device}`;
  const cached = sessions.get(key);
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
  const session = await openDeviceSession(origin, profileTree ?? device.profileTree, device.device, device.seed);
  sessions.set(key, { token: session.token, expiresAt: session.expiresAt });
  return session.token;
}

/** A client that speaks for `testDevice(name)` at `origin` through a session. */
export async function deviceClient(
  origin: string,
  name: string,
  options: ConstructorParameters<typeof ProtocolClient>[2] & { profileTree?: string } = {},
): Promise<ProtocolClient> {
  const { profileTree, ...clientOptions } = options;
  return new ProtocolClient(origin, await deviceSession(origin, name, profileTree), clientOptions);
}

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

/** Sign bytes as `testDevice(name)`, for challenges a test answers by hand. */
export function signAsDevice(name: string, bytes: Uint8Array): string {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(testDevice(name).seed, "base64url")]), format: "der", type: "pkcs8" });
  return sign(null, bytes, key).toString("base64url");
}

/** A session token straight from a daemon, for tests that never serve HTTP. */
export async function daemonSession(overstoryd: HostDaemon, name: string, origin = "http://127.0.0.1"): Promise<string> {
  const device = testDevice(name);
  const challenge = await overstoryd.createDeviceSessionChallenge({ origin, profileTree: device.profileTree, device: device.device });
  return (await overstoryd.openDeviceSession({ origin, challenge, signature: signAsDevice(name, deviceSessionChallengeBytes(challenge)) })).token;
}
