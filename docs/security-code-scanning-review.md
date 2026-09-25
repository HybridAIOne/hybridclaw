# Code-scanning review — 2026-09-25

Reviewed all ten open GitHub CodeQL alerts against checkout
`26f564eaefae7c1d44faf1ffed11022aa68591e6`, the commit recorded in each alert.
All ten are false positives; each dismissal records its specific justification
in GitHub. No scanning rules were disabled.

| Alert | Evidence |
| --- | --- |
| 79 | OpenAI execution-session SHA-256 derives an identifier from conversation/configuration data, not a password verifier. |
| 47 | Trajectory SHA-256 sorts deterministic samples. |
| 46 | Trace export SHA-256 callers produce identifiers, username pseudonyms, prompt fingerprints and content checksums. These are not password verifiers; pseudonyms are not encryption. |
| 44 | Container SHA-256 detects changes in image/build inputs. |
| 41 | Twilio HMAC-SHA1 authenticates webhook requests using the protocol-required signature. It is not password storage. |
| 40 | Telegram SHA-256 names a per-bot update-offset file. |
| 39 | Observability SHA-256 derives an event idempotency key from event metadata. |
| 80 | Host Bash receives fixed wrapper source and separate positional path arguments. The wrapper quotes those paths. Approved commands are intentionally executed from separately framed stdin. |
| 24 | Docs search text and attributes are HTML-escaped, Markdown output is sanitized, and embedded JSON escapes less-than characters. |
| 23 | The flagged raw-file response uses `text/markdown`. Rendered HTML follows separate escaping/sanitization paths. |

## Hardening and regression coverage

Docs responses gain `X-Content-Type-Options: nosniff` to prevent content-type
sniffing, including raw Markdown responses. This is defense in depth; it does
not replace escaping or sanitization. The only production change is one line
in `src/gateway/docs.ts` (an existing file over 1,000 lines); no fact lists or
security mechanisms were duplicated. Authentication, hashing algorithms,
approval policies and command execution behavior remain unchanged.

New tests exercise stored and reflected script markup, unsafe Markdown links,
embedded JSON script termination, cold/cached rendering, raw Markdown content
type, and shell metacharacters in the environment-derived temporary directory.
The shell test uses real Bash execution and checks that injected commands do
not create files.

Validation: 92 distinct targeted tests pass across Bash tools, docs security,
real HTTP docs integration, voice signatures, Telegram runtime, container
setup, trace exports, observability ingestion, OpenAI default-agent routing,
and trajectory sampling. `npm run typecheck` and `npm run lint` pass.

Full CodeQL analysis was not rerun locally; dismissals are evidence-based
triage of the existing analysis. Full unit, live-provider and Docker suites
were not run because the production change only adds a docs response header.
The response-header hardening takes effect when this change is deployed.
