# Retrieval Eval Example

Use this small corpus shape to measure whether retrieval changes improve or regress source discovery.

```bash
kbx eval retrieval examples/retrieval-eval/workspace-smoke.json -k 5
```

Each case expects one or more source paths. Recall counts unique relevant sources, so repeated chunks from the same file do not inflate the score.
