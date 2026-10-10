/** Disposable, repeatable sidecar workloads the edit benchmark does not reach;
 * never opens Canopy data. Log entries are written in memory as overstoryd writes
 * them, and an in-process sidecar answers.
 *
 * - `checkpoint`: a snapshot conflicting with the head in K files, answered
 *   warm: one checkpoint with K whole-file choices.
 * - `replay`: a cold sidecar rebuilding an L-entry chain in which every
 *   other entry was authored concurrently (run()'s full path), with and
 *   without a choice left open from the chain's start.
 *
 *   bun tests/performance/benchmark-merge-replay.ts
 *   KS=1,16,64 LS=16,64,128 FILES=120 bun tests/performance/benchmark-merge-replay.ts
 */
import { performance } from "node:perf_hooks";
import {
  compareProtocolNames,
  decodeProtocolDirectory,
  encodeProtocolDirectory,
  hashObject,
  stableJSONString,
  type ProtocolDirectoryEntry,
  type SourceOperation,
} from "@ovst/protocol";
import { encodeLogEntry, LOG_ENTRY_FORMAT, type Candidate, type LogEntry, type MergeQuestion } from "@ovst/merge-protocol";
import { Sidecar } from "../../packages/overstoryd-merge/src/sidecar.ts";
import { executeExactSourceEdits } from "../support/source-edits.ts";

const list = (name: string, fallback: number[]) => process.env[name]?.split(",").map(Number) ?? fallback;
const KS = list("KS", [1, 16, 64]), LS = list("LS", [16, 64, 128]);
const FILES = Number(process.env.FILES ?? 120), REPEATS = Number(process.env.REPEATS ?? 5);
const RULES = { id: "tree-default", revision: 1, config: { contentChoices: "source", conflictProjection: "current", maxMillis: 20_000 } };

// ---- An in-memory object store and history ---------------------------------

const objects = new Map<string, Uint8Array>();
const put = (bytes: Uint8Array) => { const hash = hashObject(bytes); objects.set(hash, bytes); return hash; };
const text = (value: string) => put(new TextEncoder().encode(value));
const read = async (hash: string) => objects.get(hash) ?? Promise.reject(new Error(`missing ${hash}`));

/** A root with `files` (path → content) in nested folders. */
function tree(files: Record<string, string>): string {
  const build = (prefix: string): string => {
    const entries = new Map<string, ProtocolDirectoryEntry>();
    for (const [path, content] of Object.entries(files)) {
      if (!path.startsWith(prefix)) continue;
      const [name, ...rest] = path.slice(prefix.length).split("/");
      if (entries.has(name!)) continue;
      entries.set(name!, rest.length ? { name: name!, directory: build(`${prefix}${name}/`) } : { name: name!, file: text(content) });
    }
    return put(encodeProtocolDirectory({ type: "directory", entries: [...entries.values()].sort((a, b) => compareProtocolNames(a.name, b.name)) }));
  };
  return build("");
}

function sidecar(): Sidecar {
  return new Sidecar({
    shared: { find: async (hash) => objects.get(hash) ?? null, has: async (hash) => objects.has(hash) },
    // overstoryd adopts an answer's objects into its store.
    staging: { find: async (hash) => objects.get(hash) ?? null, stage: async (values) => { for (const v of values) objects.set(v.hash, v.bytes); } },
  }, Number.MAX_SAFE_INTEGER, undefined, Number.POSITIVE_INFINITY);
}

function writeEntry(entry: Omit<LogEntry, "format">): string {
  return put(encodeLogEntry({ format: LOG_ENTRY_FORMAT, ...entry }));
}

/** What overstoryd records of a question (see `asked` in overstoryd). */
function asked(question: MergeQuestion, root: string) {
  const end = question.candidate.trace ? question.candidate.trace.at(-1)?.after ?? root : root;
  return {
    ...(question.base !== question.head ? { base: question.base } : {}),
    ...(question.candidate.root !== end ? { candidate: question.candidate.root } : {}),
    rules: question.rules,
  };
}

/** Ask `question` of `answering` and record its entry on `question.head`. */
async function accept(answering: Sidecar, question: MergeQuestion): Promise<{ entry: string; root: string }> {
  const answer = await answering.answer(question);
  remember(answer);
  const head = JSON.parse(new TextDecoder().decode(objects.get(question.head)!)) as LogEntry;
  const entry = writeEntry({
    tree: head.tree, previous: question.head, root: answer.root, change: question.candidate.change,
    trace: question.candidate.trace, resolves: question.candidate.resolves, decisions: answer.decisions,
    asked: asked(question, answer.root), ...(answer.evidence != null ? { evidence: answer.evidence } : {}),
  });
  return { entry, root: answer.root };
}

async function fileAt(root: string, path: string): Promise<string> {
  let dir = root;
  const names = path.slice(1).split("/");
  for (const [index, name] of names.entries()) {
    const entry = decodeProtocolDirectory(objects.get(dir)!).entries.find((e) => e.name === name)!;
    if (index === names.length - 1) return entry.file!;
    dir = entry.directory!;
  }
  throw new Error("unreachable");
}

/** A traced candidate inserting `insert` at the start of `path`. */
async function traced(root: string, path: string, insert: string, change: string): Promise<Candidate> {
  const operations: SourceOperation[] = [{ key: "edit", kind: "editSource",
    source: { material: { kind: "basis", path, object: await fileAt(root, path) }, range: [0, 0] }, text: insert }];
  const executed = await executeExactSourceEdits(root, operations, read);
  for (const [hash, bytes] of executed.generated) objects.set(hash, bytes);
  return { root: executed.root, change, trace: [{ before: root, after: executed.root, operations }], resolves: [] };
}

const files: Record<string, string> = {};
for (let index = 0; index < FILES; index++)
  files[`part-${index % 6}/page-${index}.md`] = `# Page ${index}\n\n${`Paragraph ${index} of body text.\n\n`.repeat(24)}`;
// Binary files conflict whole: the checkpoint workload changes K of them.
for (let index = 0; index < Math.max(...KS); index++) files[`part-${index % 6}/blob-${index}.bin`] = `base ${index}\0`;
const page = (index: number) => `/part-${(index % FILES) % 6}/page-${index % FILES}.md`;
const start = tree({ ...files, "choice.bin": "base\0" });
/** Every answer, digested: equal across engine changes that must not change answers. */
const answers: string[] = [];
const remember = (answer: { root: string; decisions: unknown }) => answers.push(stableJSONString({ root: answer.root, decisions: answer.decisions }));
const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!;
const round = (value: number) => Math.round(value * 100) / 100;

// ---- (a) One checkpoint with K conflicting files ---------------------------

for (const k of KS) {
  const genesis = writeEntry({ tree: "tree", previous: null, root: start, change: "genesis", trace: null, resolves: [], decisions: [] });
  const binary = (index: number, side: string) => ({ [`part-${index % 6}/blob-${index}.bin`]: `${side} ${index}\0` });
  const changed = (side: string) => Object.assign({}, files, ...Array.from({ length: k }, (_, index) => binary(index, side)));
  // A concurrent snapshot already accepted as the head.
  const headRoot = tree({ ...changed("head"), "choice.bin": "base\0" });
  const head = writeEntry({ tree: "tree", previous: genesis, root: headRoot, change: "head", trace: null, resolves: [], decisions: [] });
  const question: MergeQuestion = { base: genesis, head, rules: RULES,
    candidate: { root: tree({ ...changed("mine"), "choice.bin": "base\0" }), change: "mine", trace: null, resolves: [] } };
  const answering = sidecar();
  const first = await answering.answer(question);
  remember(first);
  if (first.decisions.length !== k) throw new Error(`expected ${k} choices, got ${first.decisions.length}`);
  const times: number[] = [];
  for (let index = 0; index < REPEATS; index++) {
    const started = performance.now();
    remember(await answering.answer(question));
    times.push(performance.now() - started);
  }
  console.log(JSON.stringify({ workload: "checkpoint", files: FILES, conflicts: k, minMs: round(Math.min(...times)), medianMs: round(median(times)) }));
}

// ---- (b) Cold replay of an L-entry chain with concurrent work --------------

/** A chain of `length` entries after genesis: pairs of traced edits authored
 * on the same entry, the first fast-forwarding and the second merged
 * concurrently onto it. With `open`, genesis's successor leaves a whole-file
 * choice open, so every later entry carries it. */
async function chain(length: number, open: boolean): Promise<string> {
  const author = sidecar();
  let at = writeEntry({ tree: "tree", previous: null, root: start, change: `genesis-${open}`, trace: null, resolves: [], decisions: [] });
  let root = start, made = 0;
  if (open) {
    const theirs = writeEntry({ tree: "tree", previous: at, root: tree({ ...files, "choice.bin": "theirs\0" }), change: "theirs", trace: null, resolves: [], decisions: [] });
    ({ entry: at, root } = await accept(author, { base: at, head: theirs, rules: RULES,
      candidate: { root: tree({ ...files, "choice.bin": "mine\0" }), change: "mine", trace: null, resolves: [] } }));
    made += 2;
  }
  for (let index = 0; made < length; index++) {
    const basis = { entry: at, root };
    const first = await traced(basis.root, page(index), `A${index} `, `a-${open}-${index}`);
    ({ entry: at, root } = await accept(author, { base: basis.entry, head: basis.entry, rules: RULES, candidate: first }));
    const second = await traced(basis.root, page(index + 3), `B${index} `, `b-${open}-${index}`);
    ({ entry: at, root } = await accept(author, { base: basis.entry, head: at, rules: RULES, candidate: second }));
    made += 2;
  }
  return at;
}

for (const open of [false, true])
  for (const length of LS) {
    const last = await chain(length, open);
    const times: number[] = [];
    let replayed = 0;
    for (let index = 0; index < Math.max(1, Math.min(REPEATS, 3)); index++) {
      // A question on the last entry: the cold sidecar replays the whole chain first.
      const cold = sidecar();
      const candidate = await traced((JSON.parse(new TextDecoder().decode(objects.get(last)!)) as LogEntry).root, page(1), "Z ", `z-${open}-${length}-${index}`);
      const started = performance.now();
      remember(await cold.answer({ base: last, head: last, rules: RULES, candidate }));
      times.push(performance.now() - started);
      replayed = cold.replayed;
    }
    const ms = median(times);
    console.log(JSON.stringify({ workload: "replay", openChoice: open, files: FILES, entries: replayed, totalMs: round(ms), perEntryMs: round(ms / replayed) }));
  }
console.log(JSON.stringify({ answers: answers.length, answersDigest: hashObject(new TextEncoder().encode(answers.join("\n"))), rssBytes: process.memoryUsage().rss }));
