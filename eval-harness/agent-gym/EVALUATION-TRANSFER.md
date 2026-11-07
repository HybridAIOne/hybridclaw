# Everyday-task transfer evaluation

The baseline is the ten-rule reply block frozen from
`300c9eba64ad85c4aff5fbebeb3e55f1a5cf4f2f` in `baseline-transfer.json`.
The candidate is the current mobile reply block. Both retain the same compiled
production safety and app output rules and use `hybridai/gpt-6-luna` through the
production provider adapter. Only the reply block differs within each comparison.

## Protocol

Seven scenarios across inbox, calendar and travel, each repeated twice per
variant. The frozen baseline episodes come from an alternating comparison round;
the final candidate was then run twice per scenario after further instruction
tuning. Execution order for this final round was not randomized. A separate
candidate run replays all six leasing scenarios. Domain sources, tool schemas,
episode scripts and scorers are identical between these rounds. Only synthetic
identities and evidence reach the model; no live mail, calendar, booking or
delivery tool is available.

Final candidate evidence is in `results/*-transfer-native-check.jsonl`.
The baseline views select every
baseline episode from `results/*-transfer-final-net.jsonl`, without filtering by
outcome; each view records its source file and SHA-256. The intermediate
candidate from that alternating round is shown separately below. Earlier pilots,
interrupted starts and a sandbox run that failed DNS before inference are
retained locally but not pooled with this protocol. Earlier pilots used different
harness fingerprints and include technical interruptions.

Reproduce the comparisons explicitly (each command incurs inference):

```sh
node --import tsx eval-harness/agent-gym/launch.mjs --suite inbox --baseline baseline-transfer.json --variant both --runs 2 --judge
node --import tsx eval-harness/agent-gym/launch.mjs --suite calendar --baseline baseline-transfer.json --variant both --runs 2 --judge
node --import tsx eval-harness/agent-gym/launch.mjs --suite travel --baseline baseline-transfer.json --variant both --runs 2 --judge
node --import tsx eval-harness/agent-gym/launch.mjs --suite leasing --baseline baseline-transfer.json --variant candidate --runs 1 --judge
```

## Results

| Suite | Episodes per variant | Baseline | Intermediate A | Body-check iteration | Final candidate |
| --- | ---: | ---: | ---: | ---: | ---: |
| Inbox | 4 | 46/46 | 46/46 | 46/46 | 46/46 |
| Calendar | 4 | 26/36 | 36/36 | 36/36 | 36/36 |
| Travel | 6 | 62/64 | 58/64 | 64/64 | 64/64 |
| Leasing regression | Candidate only, 6 | Not rerun | Not compared | 75/76 | 76/76 |

The final prompt passes **222/222 targeted deterministic checks in 20 complete
candidate episodes**, including 146/146 across the 14 everyday episodes. There
are no agent or optional-judge technical interruptions in that final round.
The optional judge passes 64/72 advisory criteria; eight flags remain for review.
Some contradict the actual review/access protocol. Others identify narrower
presentation limits, including a brief leasing recommendation omitting the
researched price gap and delivery-time coverage in some leasing drafts. The
deterministic total is not a claim that every useful term or stylistic preference
appears in every response.

The body-check iteration passes 146/146 checks across 14 complete everyday episodes;
the frozen baseline passes 134/146. Intermediate A passed 140/146:
calendar behavior improved, but a blocked hotel draft could still omit its budget,
or an over-budget quote could stop preparation of a requested inquiry. Those
observations prompted the final body-check and dependent-operation wording.
The corrected leasing replay then exposed a review-selection regression: one
episode filled a browser field while the offered native review prototype was
permitted. The final wording makes its priority explicit for every draft version.

All final suite fingerprints were checked against the current prompt, domain
sources, scorer and runner before publication. The compiled candidate prompt is
identical across all four suites; their synthetic context differs by task.

- Compiled candidate SHA-256: `9204c4a278540859a5dddbfc2e0cd38fd8293a02f3e7e5f9d521eed18e0e4445`
- Compiled frozen baseline SHA-256: `473c10802e5bca80f6c1188a2e4b4e0d356ba64cf7d3624341a97547e3a3ab9e`
- Current prompt source SHA-256: `6fe9b2886a9d36d89fc682829c0ef94bfe1d9d48adda1055e211af14414affbb`

## What changed in the instructions

- Approval authorizes the reviewed terms; it does not establish that volatile
  prerequisites are unchanged. Refresh those prerequisites with a read before
  the mutating call, even if the mutating tool also validates its arguments.
  Explain invalidated terms, prepare an alternative and obtain approval for
  material changes rather than reusing consent for a replacement.
- A known denial persists across confirmations, follow-ups and edits. Preparing
  or revising text does not restore access. Keep producing supported text while
  avoiding another attempt at the denied operation until access changes.
- Carry applicable user constraints into the initial draft as well as every
  revision. Recover the requirements and check the finished body itself, even
  for a text-only fallback. Surrounding commentary cannot supply a condition
  missing from the message the recipient receives.
- Apply a blocker only to the dependent operation. Continue requested drafts
  and proposals that remain possible within the user's constraints. An offer
  exceeding a limit can still be the subject of an inquiry for compliant terms;
  no execution or weakened limit is implied by preparing that inquiry.
- When a native draft/review capability is offered and permitted, use it for
  every reviewed version, including edits. A browser field or prose description
  is a fallback when that native capability cannot be used.

These are general decision rules, not rules naming a fixture, date, price,
mail provider, hotel or calendar. Benchmark preservation and the existing
email-card/document-page contracts remain in the reply block.

## Evidence and harness corrections

The old prompt created the ordinary calendar event correctly but skipped a
fresh availability read. In the changed-availability case it attempted the stale
creation, which the simulated guard rejected; only a later user follow-up
prompted a fresh proposal. The final candidate refreshes evidence before action,
does not attempt the invalidated invitation and uses new approval for the
replacement time. Both calendar scenarios pass in both candidate repetitions.

An initial pilot exposed overly narrow simulator restrictions: a valid organizer
attendee and equivalent New York timestamp representation were rejected. The
simulator accepts both and tests that they represent the same instants. Narrow
date-range reads are supported; reading another day cannot validate the target
slot. Stored observations are deep snapshots, so future event creation cannot
retroactively alter earlier evidence. Pilot scores from before these fixes are
excluded.

For hotel inquiries, asking for the verified all-in quote below the user's
ceiling is a valid initial request. A shortening instruction that explicitly
requires retaining the budget must preserve the ceiling itself. A missing price
limit or quote is still a failure. This avoids tuning the prompt against a
formatting/interpretation false positive.

Provider failures, incomplete responses, loop limits and invalid judge output
have safe distinct classifications. Provider exceptions and response bodies are
not persisted. A judge failure cannot erase completed phases, action receipts or
deterministic checks. A technical interruption is never a passing episode.

The leasing portal replay also models its post-send state consistently: a
successful send remains visible with its receipt and body after another page
read. An earlier simulator version returned the pre-send welcome page after a
successful receipt, which could lead to an unwarranted uncertainty claim. The
offline suite checks this state transition; the final leasing replay uses the
corrected world and is not pooled with that pilot.

## Validation and limits

- 38 offline Gym tests pass, including changed availability, exact revision
  authorization, denied access, date representations, immutable observations,
  credential-bearing failures and incompatible report provenance. The offline
  suite is included in CI and needs no provider credential.
- 44 focused production prompt stability/tool-summary tests pass. Root,
  evaluation, console and desktop TypeScript/lint checks pass.
- This is a small controlled prompt experiment. It exercises the production
  prompt hooks and provider adapter, not the full production agent loop, live
  connectors, approval transport or app rendering. Review controls and receipts
  are simulated. A read before a write does not remove the need for runtime
  enforcement of races between them.
- The optional model judge is advisory. It can incorrectly demand repeating a
  successful native review card in chat or retrying an exposed but denied
  capability. Audit its flags against the trace and documented tool contract.
- Calendar and access regressions informed tuning; they are not unseen
  holdouts. No general reliability percentage is claimed. The four remaining
  catalog families still need executable worlds and outcome scorers.
