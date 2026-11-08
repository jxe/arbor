// The JSX runtime for views (authoring API §3): JSX builds a plain view tree,
// `{type, props, children, key}`, with no React. Function components are called at once,
// so a component that reads a row's fields joins its caller's plan.

export interface ViewNode {
  type: string;
  props: Record<string, unknown>;
  children: ViewChild[];
  key?: string | number;
}
export type ViewChild = ViewNode | string | number;

type Component = (props: Record<string, unknown>) => unknown;

export const Fragment = Symbol.for("overstory.ui.fragment");

function flatten(value: unknown, into: ViewChild[]): void {
  if (value === null || value === undefined || value === false || value === true) return;
  if (Array.isArray(value) || (typeof value === "object" && value !== null && Symbol.iterator in value && typeof value !== "string")) {
    for (const item of value as Iterable<unknown>) flatten(item, into);
    return;
  }
  if (typeof value === "object" && value !== null && (value as { type?: unknown }).type === Fragment) {
    for (const child of (value as { children: ViewChild[] }).children) into.push(child);
    return;
  }
  if (isViewNode(value)) {
    into.push(value);
    return;
  }
  if (typeof value === "object" || typeof value === "function") {
    // A stand-in from the plan pass, or anything else that isn't a view: drawn as text.
    into.push(String(value));
    return;
  }
  into.push(value as string | number);
}

export function isViewNode(value: unknown): value is ViewNode {
  return typeof value === "object" && value !== null && typeof (value as ViewNode).type === "string"
    && Array.isArray((value as ViewNode).children) && typeof (value as ViewNode).props === "object";
}

export function jsx(type: string | Component | typeof Fragment, props: Record<string, unknown> | null, key?: string | number): unknown {
  const { children, key: propsKey, ...rest } = props ?? {};
  // A key spread in with props (`{...p}` after `key`) is still the node's key, not a prop.
  const actualKey = key ?? (typeof propsKey === "string" || typeof propsKey === "number" ? propsKey : undefined);
  if (typeof type === "function") {
    return type({ ...rest, ...(children === undefined ? {} : { children }), ...(actualKey === undefined ? {} : { key: actualKey }) });
  }
  const flat: ViewChild[] = [];
  flatten(children, flat);
  if (type === Fragment) return { type: Fragment, children: flat };
  return { type, props: rest, children: flat, ...(actualKey === undefined ? {} : { key: actualKey }) } satisfies ViewNode;
}

export const jsxs = jsx;

export declare namespace JSX {
  type Element = any;
  interface IntrinsicElements { [name: string]: any }
  interface ElementChildrenAttribute { children: {} }
}
