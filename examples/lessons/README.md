# Lessons fixtures

Sample reports demonstrating the lessons miner live here. Run the aggregator to
see deduplication across implementer, meta, and winner summaries:

```bash
node tm.mjs lessons mine --from "examples/lessons/**/*.json" --out examples/lessons/lessons.merged.json
```

`lessons.merged.json` is committed so you can diff the normalized output after
editing individual reports.
