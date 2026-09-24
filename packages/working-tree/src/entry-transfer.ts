import { decodeProtocolDirectory, encodeProtocolDirectory, hashObject, verifyTreeSnapshotGraph, type TreeSnapshot, type SourceOperation } from "@overstory/protocol";

/** Exact editor-declared relocation. This constructs a candidate; it does not infer
 * moves from snapshots or reconcile concurrent trees. */
export interface EntryTransfer { kind: "moveEntry" | "copyEntry"; source: string; parent: string; name: string; rewrites?: Record<string,string> }
export function prepareEntryTransfer(graph: TreeSnapshot, input: EntryTransfer, context: {change?:string; candidate?:TreeSnapshot} = {}): {candidate: TreeSnapshot; operations: SourceOperation[]} {
  verifyTreeSnapshotGraph(graph,"sparse-files");
  const components=(path:string)=>{
    if(path==="/")return [];
    const parts=path.slice(1).split("/");
    if(!path.startsWith("/")||parts.some(p=>!p||p==="."||p===".."||/[\\\0]/.test(p)||p.normalize("NFC")!==p))throw Error("Invalid entry path");
    return parts;
  };
  const source=components(input.source),parent=components(input.parent);
  if(!source.length||components("/"+input.name).length!==1||input.parent===input.source||input.parent.startsWith(input.source+"/"))throw Error("Invalid entry destination");
  const objects=new Map(graph.objects);
  for(const [hash,bytes] of context.candidate?.objects ?? []) {
    if(hashObject(bytes)!==hash)throw Error("Invalid candidate object");objects.set(hash,bytes);
  }
  const directory=(hash:string)=>{const bytes=objects.get(hash);if(!bytes)throw Error("Missing directory");return decodeProtocolDirectory(bytes);};
  const locate=(parts:string[])=>{let hash=graph.root;for(const name of parts){const entry=directory(hash).entries.find(e=>e.name===name);if(!entry?.directory)throw Error("Path crosses a file or tree boundary");hash=entry.directory;}return hash;};
  const sourceParent=locate(source.slice(0,-1)),destination=locate(parent);
  const entry=directory(sourceParent).entries.find(e=>e.name===source.at(-1));
  if(!entry||entry.tree)throw Error("Entry unavailable or tree boundary");
  if(directory(destination).entries.some(e=>e.name===input.name))throw Error("Entry destination exists");
  function change(hash:string,parts:string[],mutate:(d:ReturnType<typeof directory>)=>void):string{
    const d=directory(hash);
    if(!parts.length)mutate(d);
    else{const e=d.entries.find(e=>e.name===parts[0]);if(!e?.directory)throw Error("Missing parent");e.directory=change(e.directory,parts.slice(1),mutate);}
    d.entries.sort((a,b)=>Buffer.compare(Buffer.from(a.name),Buffer.from(b.name)));
    const bytes=encodeProtocolDirectory(d),next=hashObject(bytes);objects.set(next,bytes);return next;
  }
  let root=graph.root;
  if(input.kind==="moveEntry")root=change(root,source.slice(0,-1),d=>{d.entries=d.entries.filter(e=>e.name!==source.at(-1));});
  root=change(root,parent,d=>{d.entries.push({...entry,name:input.name});});
  const operations:SourceOperation[]=[{key:"entry-transfer",kind:input.kind,source:{material:{kind:"basis",path:input.source,object:(entry.file??entry.directory)!}},destination:{parent:{material:{kind:"basis",path:input.parent,object:destination}},name:input.name}}];
  for(const [index,[relative,hash]] of Object.entries(input.rewrites ?? {}).sort(([a],[b])=>a<b?-1:a>b?1:0).entries()) {
    const parts=relative ? components("/"+relative) : [];
    let oldHash=(entry.file??entry.directory)!;
    for(const name of parts){const e=directory(oldHash).entries.find(e=>e.name===name);if(!e?.file && !e?.directory)throw Error("Missing copied material");oldHash=(e.file??e.directory)!;}
    const old=objects.get(oldHash),bytes=objects.get(hash);
    if(!old||!bytes||!context.change)throw Error("Missing copy rewrite context");
    const decoder=new TextDecoder("utf-8",{fatal:true,ignoreBOM:true});
    const a=[...decoder.decode(old)],b=[...decoder.decode(bytes)];let start=0,end=0;
    while(start<Math.min(a.length,b.length)&&a[start]===b[start])start++;
    while(end<Math.min(a.length,b.length)-start&&a[a.length-1-end]===b[b.length-1-end])end++;
    const lower=Buffer.byteLength(a.slice(0,start).join("")),upper=old.length-Buffer.byteLength(a.slice(a.length-end).join(""));
    operations.push({key:`copy-edit-${index}`,kind:"editSource",source:{material:{kind:"operation",change:context.change,operation:"entry-transfer"},...(parts.length?{within:parts}:{}),range:[lower,upper]},text:b.slice(start,b.length-end).join("")});
    const target=[...parent,input.name,...parts];
    root=change(root,target.slice(0,-1),d=>{const e=d.entries.find(e=>e.name===target.at(-1));if(!e?.file)throw Error("Copy rewrite is not a file");e.file=hash;});
  }
  const reachable=new Set<string>();function visit(hash:string,dir:boolean){if(reachable.has(hash))return;reachable.add(hash);if(dir)for(const e of directory(hash).entries){if(e.file)visit(e.file,false);else if(e.directory)visit(e.directory,true);}}
  visit(root,true);
  return {candidate:{root,objects:new Map([...objects].filter(([hash])=>reachable.has(hash)))},operations};
}

/** Independent physical effects of one atomic editor action, all authored
 * against the same graph. Dependent transforms require operation-result references. */
export interface EntryActions { transfers: EntryTransfer[]; removals: string[] }
export function prepareEntryActions(graph: TreeSnapshot, actions: EntryActions, context: {change: string; candidate?: TreeSnapshot}): {candidate: TreeSnapshot; operations: SourceOperation[]} {
  verifyTreeSnapshotGraph(graph,"sparse-files");
  if(!actions.transfers.length && !actions.removals.length)throw Error("Empty entry action");
  const sources=[...actions.transfers.map(t=>t.source),...actions.removals];
  const destinations=actions.transfers.map(t=>(t.parent==="/"?"":t.parent)+"/"+t.name);
  const overlaps=(a:string,b:string)=>a===b||a.startsWith(b+"/")||b.startsWith(a+"/");
  for(const [i,path] of sources.entries())if(sources.slice(i+1).some(p=>overlaps(path,p))||destinations.some(p=>overlaps(path,p)))throw Error("Dependent entry actions require result references");
  for(const [i,path] of destinations.entries())if(destinations.slice(i+1).some(p=>overlaps(path,p)))throw Error("Overlapping destinations");
  let current=graph;const operations:SourceOperation[]=[];
  for(const [i,transfer] of actions.transfers.entries()) {
    const original=prepareEntryTransfer(graph,transfer,context);
    current=prepareEntryTransfer(current,transfer,context).candidate;
    for(const op of original.operations) {
      const renamed=JSON.parse(JSON.stringify(op,(_key,value)=>{
        if(value?.kind==="operation"&&value.change===context.change)return {...value,operation:`entry-${i}-${value.operation}`};
        return value;
      })) as SourceOperation;
      renamed.key=`entry-${i}-${op.key}`;operations.push(renamed);
    }
  }
  const objects=new Map(current.objects);let root=current.root;
  function remove(hash:string,parts:string[]):string {
    const bytes=objects.get(hash);if(!bytes)throw Error("Missing directory");
    const d=decodeProtocolDirectory(bytes),index=d.entries.findIndex(e=>e.name===parts[0]);
    if(index<0)throw Error("Missing removal source");
    if(parts.length===1)d.entries.splice(index,1);
    else {const e=d.entries[index]!;if(!e.directory)throw Error("Removal crosses boundary");e.directory=remove(e.directory,parts.slice(1));}
    const encoded=encodeProtocolDirectory(d),result=hashObject(encoded);objects.set(result,encoded);return result;
  }
  for(const [index,path] of actions.removals.entries()) {
    const parts=path.slice(1).split("/");
    if(!path.startsWith("/")||parts.some(p=>!p||p==="."||p===".."||/[\\\0]/.test(p)||p.normalize("NFC")!==p))throw Error("Invalid removal path");
    let hash=graph.root;
    for(const [i,part] of parts.entries()) {
      const bytes=graph.objects.get(hash);if(!bytes)throw Error("Missing basis directory");
      const entry=decodeProtocolDirectory(bytes).entries.find(e=>e.name===part);
      if(!entry || !(entry.file??entry.directory) || (i<parts.length-1&&!entry.directory))throw Error("Invalid removal source");
      hash=(entry.file??entry.directory)!;
    }
    operations.push({key:`remove-${index}`,kind:"removeEntry",source:{material:{kind:"basis",path,object:hash}}});
    root=remove(root,parts);
  }
  const reachable=new Set<string>();
  function visit(hash:string,dir:boolean){if(reachable.has(hash))return;reachable.add(hash);if(dir)for(const e of decodeProtocolDirectory(objects.get(hash)!).entries){if(e.file)visit(e.file,false);else if(e.directory)visit(e.directory,true);}}
  visit(root,true);
  return {candidate:{root,objects:new Map([...objects].filter(([hash])=>reachable.has(hash)))},operations};
}
