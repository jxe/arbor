import { pageValueFromJSON, pageValueJSON, type PageValueJSON, type ProtocolPage } from "@ovst/protocol";

/** A page in the vectors' JSON, its values spelled as property operations spell them. */
export interface PageJSON { id?: string; properties: [string, PageValueJSON][]; body: string }

export const valueJSON = pageValueJSON;
export const valueFromJSON = pageValueFromJSON;

export function pageJSON(page: ProtocolPage): PageJSON {
  return {
    ...(page.id !== undefined ? { id: page.id } : {}),
    properties: page.properties.map(([key, value]) => [key, valueJSON(value)]),
    body: new TextDecoder().decode(page.body),
  };
}

export function pageFromJSON(page: PageJSON): ProtocolPage {
  return {
    type: "page",
    ...(page.id !== undefined ? { id: page.id } : {}),
    properties: page.properties.map(([key, value]) => [key, valueFromJSON(value)]),
    body: new TextEncoder().encode(page.body),
  };
}
