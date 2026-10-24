# USL examples

Schemas the tests read: each file here must check clean, and each file in
[invalid](invalid) must report exactly the codes its `// expect:` lines name.
The TypeScript tests (`tests/unit/usl*.test.ts` and others) and StoryKit's
`USLTests.swift` read them from this folder.

| File | What it tests |
|---|---|
| [books](books.usl) | the smallest case |
| [games](games.usl) | supplies-remake: ordered n:m, value arrays, views |
| [excellences](excellences.usl) | the MAI document: two n:m connections, a colored enum |
| [supplies](supplies.usl) | the Supplies example's schema (`examples/supplies/data/schema.usl`): connections with attributes, a connection on a connection |
| [stress](stress.usl) | self-relations, 1:1, ordered children, keyed ratings, number arrays, a reified enum |
