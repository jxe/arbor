import { CBORTag, type PageValue, type ProtocolPage } from "@ovst/protocol";

/** A page value in the vectors' JSON: a timestamp is `{"$date": text}` or `{"$dateTime": text}`. */
export type PageValueJSON = null | boolean | number | string | PageValueJSON[] | { [name: string]: PageValueJSON };
export interface PageJSON { id?: string; properties: [string, PageValueJSON][]; body: string }

export function valueJSON(value: PageValue): PageValueJSON {
  if (value instanceof CBORTag) return value.tag === 1004 ? { $date: value.value as string } : { $dateTime: value.value as string };
  if (Array.isArray(value)) return value.map(valueJSON);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, valueJSON(item)]));
  return value;
}

export function valueFromJSON(value: PageValueJSON): PageValue {
  if (Array.isArray(value)) return value.map(valueFromJSON);
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "$date") return new CBORTag(1004, value.$date) as PageValue;
    if (keys.length === 1 && keys[0] === "$dateTime") return new CBORTag(0, value.$dateTime) as PageValue;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, valueFromJSON(item)]));
  }
  return value;
}

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
