import type { MigrationStep } from "../../tools/batch.ts";

/**
 * Schema 32 → 33: a device keeps the clients it last named itself as
 * (`Overstory-Client`, else `User-Agent`), so `overstoryd report` can say
 * which Story each device runs. `clients` is a JSON object by product (the
 * name before `/`), null until the device next makes a request.
 */
export const deviceClients: MigrationStep = {
  from: 32,
  name: "033-device-clients",
  run(db) {
    db.run("ALTER TABLE devices ADD COLUMN clients TEXT");
  },
  verify(db) {
    const columns = (db.query("PRAGMA table_info(devices)").all() as Array<{ name: string }>).map(({ name }) => name);
    if (!columns.includes("clients")) throw new Error("devices.clients is missing");
  },
};
