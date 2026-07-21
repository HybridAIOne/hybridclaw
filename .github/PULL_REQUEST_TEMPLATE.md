## Summary

Describe the change in 2-5 bullets:

- Problem:
- Why it matters:
- What changed:
- What did not change:

## Change Type

- [ ] Bug fix
- [ ] Feature
- [ ] Docs
- [ ] Tests
- [ ] Refactor required for the fix
- [ ] Tooling or workflow
- [ ] Security hardening

## Linked Context

- Closes #
- Related #

## Licensing

- [ ] All commits are signed off (`git commit -s`) to certify the
      [DCO](https://developercertificate.org/); the contribution is licensed
      under the repository's MIT license.

## Manifesto Principle

Which manifesto principle does this serve?

- Principle:
- Changelog tag added or updated: `Manifesto: Principle <Roman numeral> - <principle title>.`

## Validation

List the checks you ran and the concrete scenarios you verified.

```bash
# Example
npm run typecheck
npm run lint
npm run test:unit
```

- Verified manually:
- Edge cases checked:
- Skipped checks and why:

## Docs And Config Impact

- [ ] README, docs, or examples updated
- [ ] Config or environment behavior changed
- [ ] Templates or workspace bootstrap files changed
- [ ] No docs or config impact

If `templates/` changed, confirm whether `src/workspace.ts` and the related
tests were updated.

## Risk Notes

- Security-sensitive paths touched? (`Yes/No`)
- Gateway, audit, approval, or container boundaries touched? (`Yes/No`)
- If yes, what is the failure mode and how did you test it?

## Secret Handling Checklist

Complete this section for PRs labeled `security`, `auth`, `credentials`,
`secrets`, `integrations`, or for any change that reads, stores, injects,
displays, logs, traces, audits, deletes, or documents credential material.

Threat model: [docs/security/threat-model.md](docs/security/threat-model.md)

- [ ] Secret classes are identified, or this PR explains why none apply.
- [ ] Raw secret values stay out of prompts, memory, transcripts, audit logs,
      telemetry, screenshots, docs examples, and tests.
- [ ] Secret resolution happens at the narrowest boundary and is bound to the
      intended host, provider, account, session, or workspace.
- [ ] Untrusted model, file, web, or tool output cannot redirect secrets to a
      new sink without validation and approval.
- [ ] Failure modes deny access and avoid echoing credential-bearing request or
      response bodies.
- [ ] Tests cover allowed behavior and at least one relevant denied or redacted
      path.

## Evidence

Attach at least one when relevant:

- [ ] Failing output before and passing output after
- [ ] Screenshot or recording
- [ ] Log snippet
- [ ] New or updated test coverage
