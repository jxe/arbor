---
date: 2026-11-11
---

# Today

A page with view blocks. Each block's element draws where the block sits.

```view
<Text>{count(c in page.children where c.done)} of {count(page.children)} done</Text>
```

```view
view Late():
  <Column>
    <Text for={c in page.children} where={not c.done, c.due < page.date}>{c.name}</Text>
  </Column>
```

```view
use "List.view"
<List id="42" />
```
