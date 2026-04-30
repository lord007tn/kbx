# Hugging Face Open Markdown Example

This example materializes a local Markdown corpus from the Hugging Face dataset [`open-index/open-markdown`](https://huggingface.co/datasets/open-index/open-markdown).

The generated files are ignored by git:

```bash
npm run example:hf-markdown
```

Then test `kbx` in this example workspace:

```bash
cd examples/hf-open-markdown
$env:KBX_EMBEDDER='hash'
node ..\..\dist\cli.mjs init .
node ..\..\dist\cli.mjs ingest files
node ..\..\dist\cli.mjs search "distributed systems" -k 5
node ..\..\dist\cli.mjs stats --fresh
```

Dataset source:

- Dataset: `open-index/open-markdown`
- Shard: `data/CC-MAIN-2026-12/00/00/000057.parquet`
- License: ODC-BY, per the dataset card
