/** Every format a rule names. Kept in a module with no imports so the engine
 * contract can read it while format-rules is still loading. */
export const FORMATS = [
  "text", "markdown", "json", "jsonl", "yaml", "toml", "csv", "tsv",
  "typescript", "javascript", "swift", "python", "html", "xml", "css", "binary",
] as const;
export type Format = (typeof FORMATS)[number];
