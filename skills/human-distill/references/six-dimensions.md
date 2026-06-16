# The Six-Dimension Persona Model

Every persona claim you extract belongs to exactly one dimension. The engine
renders each dimension into a specific place in the identity files, so
classifying well determines where (and whether) the evidence shows up.

| Dimension | Renders into | What it captures |
|---|---|---|
| `identity` | `CV.md` Profile | Role, ownership, what they are known for, self-image at work |
| `expression` | `SOUL.md` Voice | Tone, openings/sign-offs, formatting habits, humour, pet phrases, anti-patterns |
| `decision-making` | `SOUL.md` Core Truths | Heuristics, trade-offs, escalation thresholds, what evidence convinces them |
| `interpersonal` | `SOUL.md` Working With Others | Directness, feedback style, meeting behaviour, deference, pushback |
| `experience` | `CV.md` Experience | Domains, systems, projects, hard-won lessons |
| `correction` | `SOUL.md` Corrections That Stick | Explicit operator/subject corrections — these override conflicting inferences |

## What makes a good claim

- **Behavioural, not adjectival.** "Refuses Friday hotfixes unless severity
  demands it" beats "is cautious". A claim should let the coworker *act*.
- **One behaviour per claim.** Split compound observations; they merge and
  conflict independently.
- **Quote-anchored.** Prefer claims you could defend by pointing at a
  specific line in a cited document. Paraphrase the behaviour, not the words.
- **Confidence honest.** 0.9 = repeated pattern across documents; 0.7 = clear
  single instance; 0.5 = plausible reading. Below 0.5, use `openQuestions`
  instead.

## Reading evidence by source type

- **Long-form authored docs (weight ~0.9):** richest for `decision-making`
  and `experience`. Look for stated thresholds, trade-offs, and rules the
  subject writes down for others.
- **Email (weight ~0.8):** `expression` gold — real openings, sign-offs, how
  they say no. Also `interpersonal` (tone shifts by recipient).
- **Transcripts (weight ~0.55):** `interpersonal` — when they speak, how they
  disagree, who they hand topics to. Spoken voice differs from written voice;
  attribute `expression` claims to the right register.
- **Chat conversations (weight ~0.4):** casual `expression` and fast
  `decision-making` calls. One-liners are weak evidence alone; look for
  repeated patterns across days.
- **Interview answers (weight 1.0):** self-report. Strong for all dimensions
  but mark self-flattering claims at lower confidence unless corroborated by
  behavioural sources.
- **Corrections (weight 1.0):** always dimension `correction`. Never
  re-classify them.

## Conflicts

If new evidence contradicts a standing claim listed in the packet, do **not**
write a contradicting standalone claim. Set `conflictsWith` to the standing
claim's id. The engine opens a review item; the operator decides. Tone shifts
over time (old emails formal, recent chat casual) are classic legitimate
conflicts — surface them.

## What never becomes a claim

- Health, family, religion, politics, or anything not about how they work.
- Third-party behaviour (claims are about the subject only).
- Anything from a document id you cannot see in the packet (holdouts are
  invisible to you by design).
