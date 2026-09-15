import { Database } from "bun:sqlite";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { serveCanopy } from "../../packages/canopy/src/host.ts";
import { WireClient } from "../../packages/wire/src/client.ts";
import { migrateAcceptedStateLinks } from "./run.ts";

const args = Bun.argv.slice(2);
if (args.length !== 2 || args[0] !== "--disposable-copy") throw new Error("Usage: bun migrations/006-accepted-state-links/rehearse.ts --disposable-copy <freshly restored root>");
const root = resolve(args[1]!);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function inventory() {
  const db = new Database(join(root,"canopy.sqlite3"), { readonly:true });
  try {
    const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[];
    return Object.fromEntries(tables.map(({name}) => {
      let rows=db.query(`SELECT * FROM "${name.replaceAll('"','""')}" ORDER BY rowid`).all() as Record<string,unknown>[];
      if(name==="accepted_updates") rows=rows.map(({previous_id:_p,conflicted:_c,...old})=>old);
      if(name==="meta") rows=rows.filter(r=>r.key!=="schema_version");
      return [name,{count:rows.length,hash:digest(rows)}];
    }));
  } finally { db.close(); }
}
async function objects() {
  const paths=await readdir(join(root,"objects"),{recursive:true});
  const files=[];
  for(const path of paths.sort()) {
    try { files.push([path,createHash("sha256").update(await readFile(join(root,"objects",path))).digest("hex")]); }
    catch(error) { if((error as NodeJS.ErrnoException).code!=="EISDIR") throw error; }
  }
  return {count:files.length,hash:digest(files)};
}
const before=inventory(), objectBefore=await objects();
const migration=migrateAcceptedStateLinks(join(root,"canopy.sqlite3"));
const db=new Database(join(root,"canopy.sqlite3"),{readonly:true});
const host=(db.query("SELECT value FROM meta WHERE key='community_host'").get() as {value:string}).value;
const community=(db.query("SELECT tree_id FROM boundaries WHERE path='/'").get() as {tree_id:string}).tree_id;
db.close();
const running=await serveCanopy({dataRoot:root,publicOrigin:`https://${host}`,hostname:"127.0.0.1",port:0});
try {
  await running.canopy.verifyIntegrity();
  const client=new WireClient(`http://127.0.0.1:${running.server.port}`);
  const current=await client.descriptor(community);
  await client.snapshot(community,current.tree.root);
} finally { running.server.stop(true); await running.canopy[Symbol.asyncDispose](); }
const after=inventory(), objectAfter=await objects();
if(JSON.stringify(before)!==JSON.stringify(after) || JSON.stringify(objectBefore)!==JSON.stringify(objectAfter)) throw new Error("Rehearsal changed pre-existing database records or object bytes");
const report={migration,unchangedTables:before,objects:objectBefore,integrity:true,loopbackDescriptorAndSnapshot:true,liveDataTouched:false};
await writeFile(join(root,"rehearsal-report.json"),JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify(report,null,2));
