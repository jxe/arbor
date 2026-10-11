import { hkdfSync, randomBytes } from "node:crypto";
import { sha256 } from "../model/hash.ts";
import { encodeBase32 } from "../model/identity.ts";

/**
 * An agent code (accounts §5.5): 16 random bytes in unpadded base64url, which
 * is the whole secret of a device made for an agent. The device's ID and key
 * are derived from it, so a short link carrying the code is enough to sign
 * in: `https://host/~joe/notes#overstory-agent=<code>` names the tree to
 * check out and the code.
 */
export const AGENT_FRAGMENT_PREFIX = "overstory-agent=";
const AGENT_CODE = /^[A-Za-z0-9_-]{22}$/;
const SALT = Buffer.from("overstory-agent-v1", "utf8");

export function generateAgentCode(): string {
  return randomBytes(16).toString("base64url");
}

export function isAgentCode(value: string): boolean {
  return AGENT_CODE.test(value);
}

function derive(code: string, info: string, length: number): Buffer {
  if (!isAgentCode(code)) throw new Error("An agent code is 22 characters of unpadded base64url");
  return Buffer.from(hkdfSync("sha256", Buffer.from(code, "utf8"), SALT, Buffer.from(info, "utf8"), length));
}

/** The DeviceID and Ed25519 key seed an agent code stands for. */
export function agentDevice(code: string): { deviceID: string; deviceKeySeed: string } {
  return {
    deviceID: `dv_${encodeBase32(derive(code, "device-id", 16))}`,
    deviceKeySeed: derive(code, "device-key", 32).toString("base64url"),
  };
}

/** The bundle ID local registries file an agent code's device under. */
export function agentBundleID(deviceID: string): string {
  return `cb_${sha256(deviceID).slice(0, 32)}`;
}

/** `canonicalURL` with the code as its fragment: what a person pastes into `story agent start`. */
export function buildAgentLink(canonicalURL: string, code: string): string {
  if (!isAgentCode(code)) throw new Error("An agent code is 22 characters of unpadded base64url");
  const url = new URL(canonicalURL);
  if (url.search || url.hash || url.username || url.password) throw new Error("An agent link is built on a tree's canonical URL");
  return `${url.origin}${url.pathname.replace(/\/$/, "")}#${AGENT_FRAGMENT_PREFIX}${code}`;
}

/** The tree and code an agent link names, or null for anything else. */
export function parseAgentLink(value: string): { origin: string; canonicalPath: string; canonicalURL: string; code: string } | null {
  let url: URL;
  try { url = new URL(value.trim()); } catch { return null; }
  const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !loopback) || url.search || url.username || url.password) return null;
  if (!url.hash.startsWith(`#${AGENT_FRAGMENT_PREFIX}`)) return null;
  const code = url.hash.slice(1 + AGENT_FRAGMENT_PREFIX.length);
  const canonicalPath = decodeURIComponent(url.pathname).replace(/\/$/, "");
  if (!isAgentCode(code) || !canonicalPath) return null;
  return { origin: url.origin, canonicalPath, canonicalURL: `${url.origin}${url.pathname.replace(/\/$/, "")}`, code };
}
