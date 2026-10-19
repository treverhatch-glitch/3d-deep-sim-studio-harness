# Regressions

Each real bug should become a permanent file here:

`qa/regressions/<bug-id>.json`

```json
{
  "id": "BUG-0001",
  "seed": 1337,
  "tick": 50,
  "actions": [],
  "description": "what broke",
  "fixed": true
}
```

CI can replay these with `node qa/check-regressions.mjs`.
