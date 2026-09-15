import { expect, test } from "bun:test";
import vectors from "../../../conformance/wire-accepted-state.json";
import { decodeAcceptedState, decodeDecisionPage, decodeRuleEvidencePage, decodeSubmissionResponse, validateAcceptedChain } from "../../../packages/wire/src/updates/accepted-contract.ts";
import { decodeAuthoredRequestIntent } from "../../../packages/wire/src/updates/authored-contract.ts";
for (const c of vectors.cases) test(`target reads: ${c.name}`,()=>{
  const value:any=structuredClone(c.value);
  if(c.repeatDecisions) value.decisions=Array.from({length:c.repeatDecisions},(_,i)=>({...value.decisions[0],id:`decision_${i}`}));
  const decode=()=>{
    switch(c.kind) {
      case "state":return decodeAcceptedState(value);
      case "inspection":return decodeDecisionPage(value);
      case "evidence":return decodeRuleEvidencePage(value);
      case "response":return decodeSubmissionResponse(value);
      case "chain":return validateAcceptedChain(value.tree,value.previous,value.updates,value.head);
      default:throw new Error("Unexpected fixture kind");
    }
  };
  if(!c.valid) expect(decode).toThrow();
  else { const result=decode(); if(c.kind!=="chain") expect(JSON.parse(JSON.stringify(result))).toEqual(value); }
});
test("inspection context compares exact accepted-state bytes",()=>{
  const value:any=vectors.cases[2]!.value;
  expect(()=>decodeDecisionPage(value,{tree:value.tree,state:"state-e\u0301",root:value.root})).toThrow();
});
test("resolution declarations have no fixed decision or alternative count cap",()=>{
  const resolves=Array.from({length:40},(_,i)=>({state:"u1",conflict:`d${i}`,alternatives:Array.from({length:1025},(_,j)=>`a${j}`)}));
  expect(decodeAuthoredRequestIntent({base:"u1",updates:[{change:"c1",candidate:"sha256:"+"1".repeat(64),operations:[],resolves}]}).updates[0]!.resolves).toHaveLength(40);
});
