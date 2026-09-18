import {expect, test} from "bun:test";
import {encodeSSEFrame} from "@arbor/core";
import {encodeAcceptedTransitionJSON, hashObject, type AcceptedTransition} from "@arbor/wire";
import {encodeWatchFrames} from "../../../packages/canopy/src/updates/watch-frames.ts";
function transitions(count:number, text = "x"): AcceptedTransition[] {
 const bytes=new TextEncoder().encode(text),root=hashObject(bytes);
 return Array.from({length:count},(_,i)=>({update:{id:String(i),tree:"tr_test",root,previous:null,conflicted:false,acceptedAt:i,subject:null},objects:[{hash:root,bytes}],deltas:[]}));
}
function frame(batch:AcceptedTransition[]) {
 return encodeSSEFrame({id:`cursor-${batch.at(-1)!.update.id}`,event:"tree.update",data:batch.map(encodeAcceptedTransitionJSON)});
}
test("watch replay encodes each bounded batch once when it fits",()=>{
 let calls=0;
 const values=transitions(130);
 const frames=encodeWatchFrames(values,batch=>{calls++;return frame(batch);})!;
 expect(calls).toBe(3);
 expect(frames).toEqual([frame(values.slice(0,64)),frame(values.slice(64,128)),frame(values.slice(128))]);
});
test("oversized watch batches split without losing order, cursor or byte bounds",()=>{
 const values=transitions(64,"α🙂".repeat(100));
 const limit=Buffer.byteLength(frame(values.slice(0,4)));
 const frames=encodeWatchFrames(values,frame,64,limit)!;
 expect(frames.length).toBeGreaterThan(1);
 const ids:string[]=[];
 for(const value of frames) {
  expect(Buffer.byteLength(value)).toBeLessThanOrEqual(limit);
  const data=JSON.parse(value.split("\ndata: ")[1]!.trim());
  expect(value.startsWith(`id: cursor-${data.at(-1).update.id}\n`)).toBe(true);
  ids.push(...data.map((t:any)=>t.update.id));
 }
 expect(ids).toEqual(values.map(t=>t.update.id));
 expect(encodeWatchFrames(values,frame,64,1)).toBeNull();
 expect(encodeWatchFrames([],frame)).toEqual([]);
});
