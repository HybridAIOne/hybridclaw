# Interview Protocol

The questionnaire is the highest-weight evidence source (1.0) and the only
one that can target gaps on demand. `hybridclaw coworker interview` generates
it gap-driven: dimensions with the least standing evidence get asked first.

## Two audiences

- `--audience subject` — the person being distilled answers about
  themselves. Best for `decision-making`, `experience`, `correction`
  (self-aware blind spots).
- `--audience colleague` — a teammate answers about the subject. Best for
  `expression` and `interpersonal` — people describe others' style better
  than their own. Run one per close collaborator if the operator can get
  them.

## Running it well

1. Generate after the first merge, not before — the gap-driven ordering
   needs standing claims to know what is missing:
   `hybridclaw coworker interview --alias <alias> --audience subject --out interview-1.md`
2. Tell the respondent half-sentences and stories are better than polished
   prose; the distiller reads voice as much as content.
3. Ingest the answered file with
   `hybridclaw coworker sources add --alias <alias> --kind interview <file>`
   and run a distill pass to merge it.
4. After merging, check `openQuestions` from your own extraction — fold the
   unanswered ones into the next round verbatim if the question bank did not
   cover them. You may append custom `**Q (dimension):** … **A:**` pairs to
   a generated questionnaire; the collector parses the pairs, not the count.

## Live interview variant

When the subject is available in chat, run the questionnaire conversationally:
ask one question at a time, follow up on concrete stories ("what did you
actually write back?"), and transcribe the session into the same
`**Q (dimension):** … **A:** …` format before ingesting. Follow-ups that
elicit verbatim phrasings are worth more than new questions — they feed
`expression`.

## Calibration

Self-report drifts flattering. Corroborate interview claims against
behavioural sources before giving confidence above 0.8; when an interview
answer contradicts what the chat corpus shows the subject doing, prefer the
behaviour and surface the discrepancy as a `conflictsWith` or an open
question — do not silently average.
