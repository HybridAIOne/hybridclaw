# Project record templates

Copy only the sections needed for the project. Empty tables mean no evidence
has been recorded; they must not be interpreted as no risks. Use explicit dates
with time zones where time matters. Keep restricted findings in a separately
access-controlled location and link only where the audience may access them.

## PROJECT.md

```markdown
# <Project name>

## Charter
- Project ID:
- Outcome and acceptance criteria:
- Sponsor / acceptance authority:
- Scope / exclusions:
- Target date and time zone:
- Permitted sources and report audience:
- Local record location / authoritative external tracker:
- Review cadence / scheduler ID (none until configured):
- Stop condition:

## Communication mandate
- Mode: draft-only
- Granted by / evidence / granted at:
- Allowed recipients, channels, purposes, and information:
- Cadence / maximum unanswered follow-ups:
- Business calendar / quiet hours / time zone:
- Escalation recipient and trigger:
- Expires / revoked at:

## Source coverage
| ID | Source link | Author | Source date | Observed at | Audience | Claim / confidence | Gap or conflict |
| --- | --- | --- | --- | --- | --- | --- | --- |

## Stakeholders and workflow
| Team or role | Confirmed contact | Contribution / handoff | Decision authority | Source | Last verified |
| --- | --- | --- | --- | --- | --- |

## Commitments and milestones
| ID | Deliverable / acceptance evidence | Owner (confirmed or proposed) | Due (committed or proposed) | State | Source | Next check |
| --- | --- | --- | --- | --- | --- | --- |

## Dependencies
| ID | Predecessor → successor | Providing / receiving owner | Needed by | State / impact | Evidence | Next ask |
| --- | --- | --- | --- | --- | --- | --- |

## Risks, issues, assumptions, decisions
| ID | Type | Description / impact | Evidence or uncertainty | Human owner / approver | Decision needed by | Next step / state |
| --- | --- | --- | --- | --- | --- | --- |

## Change and decision log
| At | Item | Before → after | Decided or reported by | Evidence | Affected items |
| --- | --- | --- | --- | --- | --- |

## Status brief
As of: <time>; evidence reviewed through: <time>.
Health: <green / amber / red / unknown> — <evidence-based reason>.
Changed: <material change and source>.
Delivery: <next milestone, confirmed owner, date, confidence and reason>.
Blocked: <dependency, impact, age, next ask>.
Decision needed: <human approver, options, consequence, needed-by date>.
Coverage gaps: <unread, stale, conflicting or inaccessible evidence>.
Next review: <date or manual; do not promise an unscheduled wakeup>.

## Closure / handoff
- Acceptance evidence and accepting human:
- Remaining obligations and receiving owners:
- Schedules/reminders stopped (receipt or pending):
- Reusable process knowledge (source, audience, last verified):
```

## OUTBOX.md

Maintain this ledger even in draft-only mode. Store final draft text next to its
entry. A single logical request keeps its ID across retries and channels.
Do not include secrets or source details the recipient is not allowed to see.

```markdown
# Follow-up ledger
| Request ID | Item IDs | Recipient / channel | Purpose | Authorization reference | State | Last attempt / receipt | Next eligible time | Unanswered count / stop reason |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
```

States: draft, ready (authorized but unsent), sent (receipt confirmed), uncertain
(check delivery before retry), answered, snoozed, cancelled. Refresh authorization
at send time; a ready state is not a durable permission grant. Count only
confirmed unanswered sends. On restarts, reconcile uncertain entries first.

Example draft (fictional):

> I'm the AI project coordinator for Project Example. The integration check
> depends on D-03, the API contract review. The tracker still has it awaiting
> confirmation as of Tuesday. Can you confirm the reviewer and expected review
> date, or correct the tracker? This will help the sponsor assess the test date.

Escalation draft: state the blocked outcome, last confirmed commitment,
contact attempts and responses, options with consequences, and the exact human
decision needed. Do not interpret non-response as refusal or assign blame.
