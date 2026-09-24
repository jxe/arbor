import type { DecisionReport } from "./engine-contract.ts";
import type { IntentDecision, IntentState } from "./intent-model.ts";

/** The decisions of a retained state as canopyd receives them: node
 * identities resolved to logical paths here, so the state stays opaque. */
export function decisionReports(state: Pick<IntentState, "nodes" | "decisions">): DecisionReport[] {
  const path = (nodeID: string) => {
    const names: string[] = [];
    const seen = new Set<string>();
    let node = state.nodes[nodeID];
    while (node?.parent !== null) {
      if (!node || seen.has(node.id)) throw new Error("Invalid decision path");
      seen.add(node.id);
      names.unshift(node.name);
      node = state.nodes[node.parent!];
    }
    return "/" + names.join("/");
  };
  return state.decisions.map((d: IntentDecision): DecisionReport => {
    const node = d.placement ? state.nodes[d.placement.node] : undefined;
    return {
      key: d.key,
      kind: d.kind,
      reason: d.reason,
      selected: d.selected,
      dependencies: d.dependencies,
      alternatives: d.alternatives.map(a => ({ object: a.object, state: a.state, present: a.node !== undefined, contributions: a.contributions })),
      ...(d.subject ? { subject: d.subject } : {}),
      ...(d.placement ? { placement: {
        ...(node ? { path: path(node.id) } : {}),
        ...(node?.active && !d.context
          ? { range: [d.placement.anchor, d.placement.anchor + d.placement.pieces.reduce((n, p) => n + p.length, 0)] as [number, number] }
          : {}),
      } } : {}),
    };
  });
}
