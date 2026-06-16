# The Extraction Contract (`extraction.json`)

Written next to `PACKET.md` in the run's `analysis/` directory. The engine
validates it before anything reaches the persona files: claims with missing
or unknown evidence ids are flagged into `REPORT.md` and excluded. Holdout
documents never appear in the packet, so you cannot cite them.

## Schema

```json
{
  "version": 1,
  "subject": "<alias, must match the run>",
  "runId": "<run id, from the packet>",
  "identity": {
    "name": "<short working name for the coworker>",
    "creature": "<one-line self-description, e.g. 'Distilled staff-engineer coworker'>",
    "vibe": "<three-to-six word feel, drawn from the evidence>",
    "emoji": "<single signature emoji>"
  },
  "claims": [
    {
      "dimension": "identity | expression | decision-making | interpersonal | experience | correction",
      "claim": "<one behavioural statement>",
      "evidence": ["doc_<id>", "..."],
      "confidence": 0.0,
      "conflictsWith": "claim_<id of a standing claim, only when contradicting it>"
    }
  ],
  "workModule": {
    "skillName": "<alias>-playbook",
    "description": "<one line: what working like this person means>",
    "scope": ["<task area the evidence actually covers>"],
    "workflows": [
      {
        "title": "<named workflow>",
        "steps": ["<ordered, actionable steps as the subject does them>"],
        "evidence": ["doc_<id>"]
      }
    ],
    "outputPreferences": [
      {
        "dimension": "expression",
        "claim": "<how deliverables should look>",
        "evidence": ["doc_<id>"],
        "confidence": 0.8
      }
    ],
    "knowHow": [
      {
        "topic": "<domain topic>",
        "notes": "<the actual knowledge, written to be used>",
        "evidence": ["doc_<id>"]
      }
    ],
    "workedExamples": [
      {
        "title": "<representative task>",
        "situation": "<what came in>",
        "approach": "<what the subject actually did, and why>",
        "outcome": "<optional: how it ended>",
        "evidence": ["doc_<id>"]
      }
    ]
  },
  "userNotes": ["<how the subject works with colleagues — seeds USER.md context>"],
  "openQuestions": ["<what the corpus could not answer — feeds the next interview>"]
}
```

## Validation rules the engine enforces

1. `subject` must match the run's subject; `version` must be `1`.
2. Every claim, workflow, output preference, know-how entry, and worked
   example must cite at least one document id that exists in the corpus.
   Unknown ids are dropped from the citation list; if none survive, the item
   is flagged and excluded.
3. `dimension` must be one of the six; anything else is flagged.
4. `confidence` is clamped to [0, 1].
5. `conflictsWith` only opens a review when it names a standing claim id
   from the packet; otherwise the claim merges normally.

## Working method

1. Read `PACKET.md` fully. Note the per-dimension coverage counts — they tell
   you where evidence is thin.
2. Read delta documents in packet order (highest weight first). Collect
   candidate claims as you go, each tagged with the document id you are
   reading.
3. Deduplicate against the standing claims listed in the packet — restating
   a standing claim wastes a merge; contradicting one needs `conflictsWith`.
4. Build the work module from the subject's *demonstrated* work only. A
   scope entry without a workflow or worked example behind it is padding.
5. Whatever you wanted to claim but could not support goes in
   `openQuestions` — that is the input for the next interview round, not a
   failure.
