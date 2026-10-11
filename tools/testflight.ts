// Puts an uploaded iPhone build in front of a TestFlight group, through the
// App Store Connect API:
//
//   bun tools/testflight.ts status
//   bun tools/testflight.ts distribute <version> <build> [--group Friends] [--notes "What to test"]
//
// `distribute` waits for Apple to finish processing the build, sets its What
// to Test note, adds it to the group, and submits it for beta review when the
// group is external. Authenticates with an API key: STORY_ASC_KEY_ID and
// STORY_ASC_ISSUER_ID, and the key file STORY_ASC_KEY_PATH (by default
// ~/.appstoreconnect/private_keys/AuthKey_<id>.p8). The key is read to sign
// requests and never printed.
import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const BUNDLE_ID = "org.nxhx.Arbor";
const API = "https://api.appstoreconnect.apple.com";

const keyID = process.env.STORY_ASC_KEY_ID;
const issuerID = process.env.STORY_ASC_ISSUER_ID;
if (!keyID || !issuerID) throw new Error("Set STORY_ASC_KEY_ID and STORY_ASC_ISSUER_ID");
const key = await readFile(process.env.STORY_ASC_KEY_PATH ?? join(homedir(), ".appstoreconnect/private_keys", `AuthKey_${keyID}.p8`), "utf8");

const base64url = (value: Buffer | string) => Buffer.from(value).toString("base64url");
function token(): string {
  const now = Math.floor(Date.now() / 1000);
  const head = base64url(JSON.stringify({ alg: "ES256", kid: keyID, typ: "JWT" }));
  const claims = base64url(JSON.stringify({ iss: issuerID, iat: now, exp: now + 600, aud: "appstoreconnect-v1" }));
  const signature = createSign("SHA256").update(`${head}.${claims}`).sign({ key, dsaEncoding: "ieee-p1363" });
  return `${head}.${claims}.${base64url(signature)}`;
}

type Resource = { id: string; attributes: Record<string, unknown> };
async function call(method: string, path: string, body?: unknown): Promise<{ data: Resource[] | Resource | null }> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token()}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) {
    const detail = (() => { try { return (JSON.parse(text).errors as Array<{ detail?: string; title?: string }>).map((error) => error.detail ?? error.title).join("; "); } catch { return text; } })();
    throw Object.assign(new Error(`${method} ${path.split("?")[0]}: ${response.status} ${detail}`), { status: response.status });
  }
  return text ? JSON.parse(text) : { data: null };
}
const list = async (path: string) => (await call("GET", path)).data as Resource[];

const [app] = await list(`/v1/apps?filter[bundleId]=${BUNDLE_ID}`);
if (!app) throw new Error(`No App Store Connect app has the bundle ID ${BUNDLE_ID}`);
const groups = () => list(`/v1/apps/${app.id}/betaGroups?limit=50`);
const builds = (version?: string, build?: string) => list(
  `/v1/builds?filter[app]=${app.id}&sort=-uploadedDate&limit=10`
  + (version ? `&filter[preReleaseVersion.version]=${version}` : "") + (build ? `&filter[version]=${build}` : ""));

const [command, ...rest] = process.argv.slice(2);
if (command === "status") {
  console.log(`${app.attributes.name} (${BUNDLE_ID})`);
  for (const group of await groups()) console.log(`  group: ${group.attributes.name}${group.attributes.isInternalGroup ? " (internal)" : " (external)"}`);
  for (const item of await builds()) console.log(`  build ${item.attributes.version}: ${item.attributes.processingState}, uploaded ${item.attributes.uploadedDate}`);
} else if (command === "distribute") {
  const [version, build] = rest;
  if (!version || !build) throw new Error("usage: distribute <version> <build> [--group <name>] [--notes <text>]");
  const option = (name: string) => { const index = rest.indexOf(name); return index >= 0 ? rest[index + 1] : undefined; };
  const groupName = option("--group") ?? "Friends";
  const notes = option("--notes");
  const group = (await groups()).find((candidate) => candidate.attributes.name === groupName);
  if (!group) throw new Error(`No TestFlight group is named ${groupName}`);

  // Apple lists a build only after the upload is registered, and tests it only once processed.
  let found: Resource | undefined;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    [found] = await builds(version, build);
    if (found?.attributes.processingState === "VALID") break;
    if (found && found.attributes.processingState !== "PROCESSING") throw new Error(`Build ${build} is ${found.attributes.processingState}`);
    if (attempt === 0) console.log(`Waiting for Apple to process ${version} (${build})…`);
    await Bun.sleep(20_000);
  }
  if (found?.attributes.processingState !== "VALID") throw new Error(`Build ${build} was not processed within 30 minutes; run this again later`);

  if (notes) {
    const [localization] = await list(`/v1/builds/${found.id}/betaBuildLocalizations`);
    if (localization) {
      await call("PATCH", `/v1/betaBuildLocalizations/${localization.id}`, { data: { type: "betaBuildLocalizations", id: localization.id, attributes: { whatsNew: notes } } });
    } else {
      await call("POST", "/v1/betaBuildLocalizations", { data: { type: "betaBuildLocalizations", attributes: { locale: "en-US", whatsNew: notes }, relationships: { build: { data: { type: "builds", id: found.id } } } } });
    }
  }
  await call("POST", `/v1/betaGroups/${group.id}/relationships/builds`, { data: [{ type: "builds", id: found.id }] });
  console.log(`Added ${version} (${build}) to ${groupName}.`);
  if (!group.attributes.isInternalGroup) {
    try {
      await call("POST", "/v1/betaAppReviewSubmissions", { data: { type: "betaAppReviewSubmissions", relationships: { build: { data: { type: "builds", id: found.id } } } } });
      console.log("Submitted for beta review.");
    } catch (error) {
      // A build Apple has already reviewed, or approved without review, cannot be submitted again.
      if ((error as { status?: number }).status !== 409 && (error as { status?: number }).status !== 422) throw error;
      console.log(`No beta review submission was needed: ${(error as Error).message}`);
    }
  }
} else {
  throw new Error("usage: bun tools/testflight.ts status | distribute <version> <build> [--group <name>] [--notes <text>]");
}
