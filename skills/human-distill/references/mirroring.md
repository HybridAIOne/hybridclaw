# Mirroring: the Draft–Compare–Diff Loop

Mirroring is the highest-fidelity refinement loop: the coworker drafts what
the subject *would* do for a real task, the actual human response is
revealed, and the differences become corrections. It is how a distilled
coworker converges from "plausible" to "recognisably them".

## The loop

1. **Pick a live task** the subject is about to handle anyway (an email to
   answer, a review comment, a triage decision). Never use it on anything
   the subject has not agreed to mirror.
2. **Draft blind.** The coworker (persona + work module loaded) produces its
   response *before* seeing the subject's. Save the draft.
3. **Reveal and diff.** Compare draft vs. the subject's actual response on
   four axes:
   - **Decision** — same call? same escalation?
   - **Structure** — same shape of answer (length, ordering, what is omitted)?
   - **Voice** — opening, sign-off, register, phrasing habits
   - **Judgment details** — thresholds, caveats, who gets cc'd
4. **Convert differences to corrections.** Each material difference becomes
   one `hybridclaw coworker correct --alias <alias> --note "<specific
   behavioural correction>"`. Be concrete: "ends triage messages with the
   next checkpoint time, never 'let me know'" — not "sound more like them".
5. **Re-run a distill pass** so corrections promote, then repeat with the
   next task.

## Listening mode (meetings)

The passive variant: ingest fresh meeting transcripts as they happen
(`--kind transcript` or `auto`), and after each merge ask the operator
whether the coworker's standing `interpersonal`/`expression` claims still
ring true. Drift over time is expected — declare `conflictsWith` rather than
piling on contradictory claims.

## Grading fidelity

Use the held-out prompts from `hybridclaw coworker eval --alias <alias>`
(written to `eval.json`) as a periodic benchmark: have the coworker answer
each held-out prompt, then grade draft vs. reference on the same four axes
(0–2 each, 8 max). Report the score and the worst axis to the operator;
the worst axis tells you which dimension needs the next interview or
mirroring round.

## Stop conditions

- Three consecutive mirror rounds with no material diffs on any axis: the
  persona has converged; switch to passive listening.
- The subject or operator is uncomfortable with any mirrored task:
  stop immediately and discard that draft — comfort outranks fidelity.
