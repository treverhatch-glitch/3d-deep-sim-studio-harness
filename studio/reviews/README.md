# Reviews

For non-trivial changes, add `studio/reviews/<task-id>.md`:

```md
model-family: anthropic
implementer-family: gemini
note: looked at sim purity and golden hash
```

`scripts/check-reviewer.mjs` fails if a review file is missing `model-family`.
