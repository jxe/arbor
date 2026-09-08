import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  initialAdmissionState,
  reduceAdmission,
  type AdmissionEvent,
  type AdmissionState,
} from "@arbor/arborsync-client";
import { reduceSync, type SyncEvent, type SyncState } from "@arbor/canopy-client";

interface Step {
  event: Record<string, unknown>;
  state: string;
  effects: string[];
  expect?: Record<string, unknown>;
}

interface Scenario {
  name: string;
  initial: Record<string, unknown>;
  steps: Step[];
}

interface MachineFixture {
  states: string[];
  events: string[];
  effects: string[];
  scenarios: Scenario[];
}

interface Fixture {
  version: number;
  machines: {
    "arborsync-document-admission": MachineFixture;
    "direct-canopy-synchronization": MachineFixture;
  };
}

async function loadFixture(): Promise<Fixture> {
  return JSON.parse(await readFile(join(import.meta.dir, "../../conformance/client-state-machines.json"), "utf8")) as Fixture;
}

function valueAt(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (current === null || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

/** Every named state, event, and effect must be declared, and every step must be complete. */
function validateSchema(machine: MachineFixture): void {
  const states = new Set(machine.states);
  const events = new Set(machine.events);
  const effects = new Set(machine.effects);
  expect(machine.scenarios.length).toBeGreaterThan(0);
  for (const scenario of machine.scenarios) {
    expect(scenario.steps.length).toBeGreaterThan(0);
    for (const step of scenario.steps) {
      if (!states.has(step.state)) throw new Error(`${scenario.name}: unknown state ${step.state}`);
      if (!events.has(step.event.type as string)) throw new Error(`${scenario.name}: unknown event ${String(step.event.type)}`);
      if (!Array.isArray(step.effects)) throw new Error(`${scenario.name}: step omits expected effects`);
      for (const effect of step.effects) {
        if (!effects.has(effect)) throw new Error(`${scenario.name}: unknown effect ${effect}`);
      }
    }
  }
}

function runScenario<S, E>(
  scenario: Scenario,
  initial: S,
  reduce: (state: S, event: E) => { state: S; effects: Array<{ type: string }> },
): void {
  let state = initial;
  scenario.steps.forEach((step, index) => {
    const transition = reduce(state, step.event as E);
    state = transition.state;
    const label = `${scenario.name} / step ${index + 1} (${String(step.event.type)})`;
    expect((state as { kind: string }).kind, label).toBe(step.state);
    expect(transition.effects.map((effect) => effect.type), label).toEqual(step.effects);
    for (const [path, expected] of Object.entries(step.expect ?? {})) {
      expect(valueAt(state, path), `${label}: ${path}`).toEqual(expected);
    }
  });
}

describe("client state machine fixtures", () => {
  test("declare every state, event, and effect a step names", async () => {
    const fixture = await loadFixture();
    expect(fixture.version).toBe(1);
    validateSchema(fixture.machines["arborsync-document-admission"]);
    validateSchema(fixture.machines["direct-canopy-synchronization"]);
  });

  test("the TypeScript document admission machine executes every scenario", async () => {
    const fixture = await loadFixture();
    const options = { equal: (left: string, right: string) => left === right };
    for (const scenario of fixture.machines["arborsync-document-admission"].scenarios) {
      const initial = scenario.initial as { accepted: { source: string; revision: string; admissionBasis?: string }; transport: "canopy" | "local" };
      runScenario<AdmissionState<string>, AdmissionEvent<string>>(
        scenario,
        initialAdmissionState(initial.accepted, initial.transport),
        (state, event) => reduceAdmission(state, event, options),
      );
    }
  });

  test("the TypeScript direct Canopy synchronization machine executes every scenario", async () => {
    const fixture = await loadFixture();
    for (const scenario of fixture.machines["direct-canopy-synchronization"].scenarios) {
      runScenario<SyncState, SyncEvent>(
        scenario,
        scenario.initial as unknown as SyncState,
        (state, event) => reduceSync(state, event),
      );
    }
  });

  test("the fixture rejects unknown states and incomplete steps", async () => {
    const fixture = await loadFixture();
    const machine = structuredClone(fixture.machines["arborsync-document-admission"]);
    machine.scenarios[0]!.steps[0]!.state = "unknown-state";
    expect(() => validateSchema(machine)).toThrow(/unknown state/);
    const incomplete = structuredClone(fixture.machines["direct-canopy-synchronization"]);
    delete (incomplete.scenarios[0]!.steps[0] as Partial<Step>).effects;
    expect(() => validateSchema(incomplete)).toThrow(/omits expected effects/);
  });
});
