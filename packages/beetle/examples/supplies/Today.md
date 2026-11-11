---
date: 2026-11-11
---

# Today

```view
use "Timer.beetle" (view as Timer)
<Timer minutes={50} />
```

```view
view Late():
  <Column>
    <Text for={c in page.children} where={not c.done, c.due < page.date}>{c.name}</Text>
  </Column>
```
