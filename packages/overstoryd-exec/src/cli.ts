#!/usr/bin/env bun
// overstoryd's execution sidecar process: a handshake line, then one answer
// line per question line, in any order. overstoryd starts it, restarts it,
// and never shares more than the questions say.

import { mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ExecCancel, ExecQuestion } from "@ovst/exec-protocol";
import { loadActivations } from "./load.ts";
import { ExecSidecar } from "./sidecar.ts";

const { values } = parseArgs({
  options: {
    activations: { type: "string" },
    materialized: { type: "string" },
    state: { type: "string" },
    host: { type: "string" },
  },
});
for (const name of ["materialized", "state", "host"] as const) {
  if (!values[name]) {
    console.error(`overstoryd-exec: --${name} is required`);
    process.exit(2);
  }
}
const absolute = (path: string) => isAbsolute(path) ? path : resolve(path);
for (const name of ["materialized", "state"] as const) mkdirSync(absolute(values[name]!), { recursive: true });
// The views and mutations overstoryd loaded from trees; with none, every question is refused.
const code = values.activations
  ? await loadActivations(absolute(values.activations), join(absolute(values.state!), "compiled"))
  : { views: [], mutations: [] };
const sidecar = new ExecSidecar({
  materialized: absolute(values.materialized!),
  state: absolute(values.state!),
  origin: values.host!,
  views: code.views,
  mutations: code.mutations,
});

const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const cancelled = new Set<string>();
write(sidecar.ready());

let buffer = "";
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    let message: ExecQuestion | ExecCancel;
    try {
      message = JSON.parse(line);
    } catch {
      console.error("overstoryd-exec: a line that is not JSON");
      continue;
    }
    if ("cancel" in message) {
      cancelled.add(message.cancel);
      continue;
    }
    const question = message;
    void sidecar.answer(question).then((answer) => {
      // A cancelled question's answer is not wanted; a mutation still finished.
      if (!cancelled.delete(question.id)) write(answer);
    });
  }
}
await sidecar[Symbol.asyncDispose]();
