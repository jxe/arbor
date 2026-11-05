// SPIKE: a JSX runtime that builds a plain view tree, no React.
// Function components are called at once, so a component that reads a row's
// fields is traced with its caller: a component is a fragment of the endpoint's
// shape, as in Relay, without declaring one.

export interface ViewNode {
  type: string;
  props: Record<string, unknown>;
  children: ViewChild[];
  key?: string | number;
}
export type ViewChild = ViewNode | string | number;

type Component = (props: Record<string, unknown>) => unknown;

const VIEW = Symbol.for("overstory.ui.view");

function isViewNode(value: unknown): value is ViewNode {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[VIEW] === true;
}

export const Fragment = Symbol.for("overstory.ui.fragment");

function flatten(value: unknown, into: ViewChild[]): void {
  if (value === null || value === undefined || value === false || value === true) return;
  if (Array.isArray(value)) {
    for (const item of value) flatten(item, into);
    return;
  }
  if (typeof value === "object" && value !== null && (value as { type?: unknown }).type === Fragment) {
    for (const child of (value as ViewNode).children) into.push(child);
    return;
  }
  if (isViewNode(value)) {
    into.push(value);
    return;
  }
  if (typeof value === "object" || typeof value === "function") {
    // A tracing stub, or anything else a trace hands in, stands in as text.
    into.push(String(value));
    return;
  }
  into.push(value as string | number);
}

export function jsx(type: string | Component | typeof Fragment, props: Record<string, unknown>, key?: string | number): unknown {
  if (typeof type === "function") return type(key === undefined ? props : { ...props, key });
  const { children, ...rest } = props ?? {};
  const flat: ViewChild[] = [];
  flatten(children, flat);
  const view = { type, props: rest, children: flat, ...(key === undefined ? {} : { key }) };
  Object.defineProperty(view, VIEW, { value: true });
  if (type === Fragment) return view;
  return view as ViewNode;
}

export const jsxs = jsx;
export const jsxDEV = (type: any, props: any, key?: any) => jsx(type, props, key);

export declare namespace JSX {
  type Element = any;
  interface IntrinsicElements { [name: string]: any }
  interface ElementChildrenAttribute { children: {} }
}
