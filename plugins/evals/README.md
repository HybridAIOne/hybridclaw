# Eval Runner Plugin

Install locally:

```bash
hybridclaw plugin install ./plugins/evals
```

Example commands:

```bash
/eval list
/eval mmlu --n 30
/eval mmlu --n 30 --system-prompt minimal --no-soul
/eval mmlu --subject high_school_computer_science --model openai/gpt-5.4
/eval jsonl evals/release-smoke.jsonl --n 20 --answer-mode includes
/eval runs
```

What it does:

- Runs MMLU samples against the current session model by default
- Supports multiple evaluators through a registry, currently `mmlu` and `jsonl`
- Supports `full`, `minimal`, and `none` prompt modes
- Supports targeted ablations like `--no-soul`
- Saves structured run records under `~/.hybridclaw/evals/runs/`
- Writes summary audit events for run start, per-case completion, and run completion
- Caches the published MMLU `data.tar` archive locally and reads subject CSVs from that cache
