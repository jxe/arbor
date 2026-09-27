import { Database } from "bun:sqlite";
import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/** An OS-released lock, including after a crash. Never block the JS event loop waiting for another caller. */
export async function withLocalStateLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const database = new Database(path, { create: true });
  let acquired = false;
  try {
    await chmod(path, 0o600);
    database.exec("PRAGMA busy_timeout=0");
    const deadline = Date.now() + 30_000;
    while (!acquired) {
      try { database.exec("BEGIN IMMEDIATE"); acquired = true; }
      catch (error) {
        if (!(error instanceof Error) || !/busy|locked/i.test(error.message)) throw error;
        if (Date.now() >= deadline) throw new Error("Another setup operation is still running. Wait for it to finish, then try again.");
        await Bun.sleep(25);
      }
    }
    return await operation();
  } finally {
    try { if (acquired) database.exec("ROLLBACK"); }
    finally { database.close(); }
  }
}
