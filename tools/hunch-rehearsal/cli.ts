#!/usr/bin/env bun
import {
  applyRun,
  draftRecipe,
  expandUserPath,
  inventorySource,
  readManifest,
  recordDryRun,
  verifyRun,
} from "./conversion.ts";

interface Options {
  command: string;
  source?: string;
  recipe?: string;
  destination?: string;
  runId?: string;
  manifest?: string;
  output?: string;
  draftRecipe?: string;
  knownGaps: string[];
}

function usage(exitCode = 2): never {
  console.error(`Usage: bun run hunch:rehearsal <command> [options]

Commands:
  inventory  Inspect a Hunch workspace without writing it
  dry-run    Plan a conversion and record one matching confirmation
  apply      Create a new destination after two matching dry runs
  verify     Compare a converted destination with its recorded manifest

Options:
  --source <path>          Hunch workspace (inventory, dry-run, apply)
  --recipe <path>          Private reviewed JSON recipe (dry-run, apply)
  --destination <path>     New Arbor destination (dry-run, apply; optional for verify)
  --run-id <id>            Stable lowercase run identifier (dry-run, apply)
  --manifest <path>        Private per-run JSON manifest (dry-run, apply, verify)
  --output <path>          Write inventory JSON privately instead of stdout
  --draft-recipe <path>    With inventory, write a private draft recipe for review
  --known-gap <text>       Record a current product gap (repeatable; dry-run only)

Run dry-run twice with the same arguments and manifest before apply. The tool
never writes the Hunch source, never overwrites a destination, and never stores
the private recipe or manifest inside the converted Arbor tree.
`);
  process.exit(exitCode);
}

function parseOptions(argv: string[]): Options {
  const command = argv.shift() ?? "help";
  const options: Options = { command, knownGaps: [] };
  while (argv.length) {
    const flag = argv.shift()!;
    const value = argv.shift();
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    if (flag === "--source") options.source = value;
    else if (flag === "--recipe") options.recipe = value;
    else if (flag === "--destination") options.destination = value;
    else if (flag === "--run-id") options.runId = value;
    else if (flag === "--manifest") options.manifest = value;
    else if (flag === "--output") options.output = value;
    else if (flag === "--draft-recipe") options.draftRecipe = value;
    else if (flag === "--known-gap") options.knownGaps.push(value);
    else throw new Error(`Unknown option: ${flag}`);
  }
  return options;
}

function required(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

async function writePrivateOutput(pathInput: string, value: unknown): Promise<void> {
  const path = expandUserPath(pathInput);
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function summary(manifest: Awaited<ReturnType<typeof readManifest>>["manifest"]): unknown {
  return {
    runId: manifest.runId,
    source: manifest.source,
    destination: manifest.destination,
    sourceDigest: manifest.sourceDigest,
    recipeDigest: manifest.recipeDigest,
    repositoryState: manifest.repositoryState,
    knownGaps: manifest.knownGaps,
    planDigest: manifest.planDigest,
    dryRunConfirmations: manifest.dryRuns.length,
    appliedAt: manifest.appliedAt,
    verifiedAt: manifest.verifiedAt,
    keptPages: manifest.keptPages,
    discardedPages: manifest.discardedPages,
    assetFiles: manifest.assetFiles,
    preservedPageIDs: manifest.preservedPageIDs,
    suppliedPageIDs: manifest.suppliedPageIDs,
    linkWarnings: manifest.linkWarnings,
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.command === "help" || options.command === "--help" || options.command === "-h") usage(0);
  if (options.command === "inventory") {
    const source = required(options.source, "--source");
    const inventory = await inventorySource(source);
    if (options.output) await writePrivateOutput(options.output, inventory);
    else console.log(JSON.stringify(inventory, null, 2));
    if (options.draftRecipe) await draftRecipe(source, options.draftRecipe);
    return;
  }
  if (options.command === "dry-run") {
    const manifest = await recordDryRun({
      source: required(options.source, "--source"),
      recipePath: required(options.recipe, "--recipe"),
      destination: required(options.destination, "--destination"),
      runId: required(options.runId, "--run-id"),
      manifestPath: required(options.manifest, "--manifest"),
      knownGaps: options.knownGaps,
    });
    console.log(JSON.stringify(summary(manifest), null, 2));
    return;
  }
  if (options.command === "apply") {
    const manifest = await applyRun({
      source: required(options.source, "--source"),
      recipePath: required(options.recipe, "--recipe"),
      destination: required(options.destination, "--destination"),
      runId: required(options.runId, "--run-id"),
      manifestPath: required(options.manifest, "--manifest"),
    });
    console.log(JSON.stringify(summary(manifest), null, 2));
    return;
  }
  if (options.command === "verify") {
    const manifest = await verifyRun({
      manifestPath: required(options.manifest, "--manifest"),
      ...(options.destination ? { destination: options.destination } : {}),
    });
    console.log(JSON.stringify(summary(manifest), null, 2));
    return;
  }
  throw new Error(`Unknown command: ${options.command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
