# Research and attribution

Research date: 2026-09-22. This package is an independent implementation, not an
endorsement or a claim of affiliation with the sources below.

## Origin

The user supplied Steve Yegge's Agentic TPM proposal: bounded project agents
that ask, observe, document, report, and follow up while accumulating organizational
context. Credit for that motivating idea belongs to **Steve Yegge**. His
[website](https://yegge.ai/) identifies his work and background. The exact post's
permalink/date was not independently established; the supplied text is the
source for the proposal, not the website homepage. No claim is made that the
homepage publishes or validates this particular proposal.

## Independently consulted practices

- [Atlassian: DACI decision-making framework](https://www.atlassian.com/team-playbook/plays/daci).
  Separates coordinating a decision (Driver) from making it (Approver), with
  Contributors and Informed parties. Applied here by retaining a named human
  decision-maker for each blocked decision.
- [Atlassian: Network of Teams](https://www.atlassian.com/team-playbook/plays/network-of-teams).
  Maps adjacent teams, their relevance, and relationship owners. Applied here
  as a source-backed dependency and stakeholder map rather than an inferred
  org chart or a list of people to chase.
- [Amazon: Technical Program Manager III, Amazon CloudWatch](https://www.amazon.jobs/en/jobs/10552527/technical-program-manager-iii-amazon-cloudwatch).
  Describes cross-functional program coordination, processes, and release
  scheduling. Supports the coordination use case; it does not establish that
  human TPMs universally have no authority or resources.

## Design conclusions and limits

The package adopts coordination without delivery authority as an explicit role
boundary. It does not treat that boundary as a universal definition of TPM work.
The sources do not validate the proposal's predictions about enterprise adoption,
cost, virality, or next-year AI employees. Those remain hypotheses.

Messaging, publication, and knowledge aggregation can affect people and disclose
information even without code execution. Accordingly this implementation uses
explicit communication mandates, recipient-aware summaries, source provenance,
bounded follow-ups, and delivery receipts. These are our design judgments,
not measured findings from the sources.

A proposed pilot should compare blocker age, time to human decisions, ownership
coverage, and time spent preparing status reports against a recorded baseline.
Also track duplicate or unwanted messages, unsupported claims, and corrections.
Agree success/stop criteria with the sponsor before interpreting results. Avoid
employee performance scoring or counting messages as evidence of productivity.
