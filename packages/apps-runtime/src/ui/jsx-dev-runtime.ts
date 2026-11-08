import { jsx } from "./jsx-runtime.ts";

export { Fragment, type JSX } from "./jsx-runtime.ts";
export const jsxDEV = (type: any, props: any, key?: any) => jsx(type, props, key);
