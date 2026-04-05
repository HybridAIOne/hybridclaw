# Eval Runner Plugin

Install locally:

```bash
hybridclaw plugin install ./plugins/evals
```

Example commands:

```bash
/eval mmlu --n 30
/eval mmlu --n 30 --system-prompt minimal --no-soul
/eval mmlu --subject high_school_computer_science --model openai/gpt-5.4
/eval runs
```

What it does:

- Runs MMLU samples against the current session model by default
- Supports `full`, `minimal`, and `none` prompt modes
- Supports targeted ablations like `--no-soul`
- Saves structured run records under `~/.hybridclaw/evals/runs/`
- Writes summary audit events for run start, per-case completion, and run completion
