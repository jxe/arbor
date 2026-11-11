# Agents 005: webhook runners, starting with a claude.ai scheduled task

**Why:** Run should work with the Mac asleep. A webhook runner is a URL and a secret Story POSTs the run request to (Joe, 2026-11-06). Split from Agents 002 (Joe, 2026-11-07): it depends on the claude.ai routine API trigger, still a beta header, and each person allowing their host's domain in their claude.ai environment.

**Order:** after [Agents 002](../../status.md#agents-002-run-tasks-from-anywhere--2026-11-07), which defines the run
request, `story agent start --task` and the Runners list.

Runners will also handle data events, not only run requests
([Apps 017](../later/apps-017-data-runners.md), Joe 2026-11-11), so keep `runners.yaml`
entries and webhook delivery general enough for other request kinds.

## Status

- **Effort:** S to M.
- **Risk:** MEDIUM: it starts agents with write access to your trees from elsewhere.

## The work

- **A Runners list in the configuration tree** (Joe, 2026-11-06; spec 04 §7), since a
  webhook runner isn't present to be found: `runners.yaml`, so every device of the account
  sees it. `tree-config-v1`'s closed file set gains it: entries keyed by a runner ID, each
  with its label, URL, default flag, and the `DeviceID` of its bundle from `devices.yaml`.
  Revoking that device removes the runner, and removing the runner revokes the device, in
  one accepted root. No secret is written there: the webhook's secret stays in the Keychain
  (synced by iCloud), and the bundle's credential stays where it was handed out. Settings on
  the Mac and iPhone shows present runners beside these, and which is the default.

- **The request.** `POST <url>` with the run request as JSON and `Authorization: Bearer
  <secret>`. The runner's answer may carry `{ "url": … }`, which the block menu opens ("Open
  session"). Errors show on the block.
- **Access.** A webhook runner usually starts on a machine with nothing placed.
  Adding one mints a bundle for it (on a device that can create bundles) and the request
  carries its agent link, so the remote side needs no stored secret of ours; removing the
  runner revokes the bundle (Joe, 2026-11-06).
- **The claude.ai preset.** A scheduled task with only an API trigger: the request goes as
  `{"text": …}` with the beta header `experimental-cc-routine-2026-04-01`. Fire text arrives
  wrapped as untrusted `<routine-fire-payload>`, so the saved prompt opts in: "Run the Story
  task in the payload: `npx @ovst/cli agent start --task` with it, do the task, `done`,
  `finish`." The fire text is never approval, so the skill's "ask before what you can't undo"
  holds. `npx` needs no setup script, since npm is on the default allowlist; the user still
  allows their host's domain in the environment's network settings, which nothing can do for
  them. "Add claude.ai runner…" copies the prompt, opens claude.ai/code/routines, and takes
  the fire URL and token back, checking them with a test fire. Limits: 30 fires an hour per
  task; a cold start takes a minute or two.
- **Other webhooks** (GitHub Actions, your own server) take the same JSON; docs give one
  example of each.

**Verification:** a local webhook harness receives the request and runs phase 2's path; an
iOS unit test for both request shapes; by hand, Run from the iPhone with the Mac asleep
through the claude.ai preset.


## Close out

Record what was built in `status.md` and delete this plan.
