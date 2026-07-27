import { basename, dirname, join } from "node:path";

/**
 * iCloud Drive represents an evicted file `report.pdf` as
 * `.report.pdf.icloud`. Treat that marker as state for the logical file,
 * never as a readable file of its own.
 */
export function iCloudPlaceholderLogicalName(physicalName: string): string | null {
  if (!physicalName.startsWith(".") || !physicalName.endsWith(".icloud")) return null;
  const logical = physicalName.slice(1, -".icloud".length);
  return logical || null;
}

export function iCloudPlaceholderPath(logicalAbsolutePath: string): string {
  return join(dirname(logicalAbsolutePath), `.${basename(logicalAbsolutePath)}.icloud`);
}
