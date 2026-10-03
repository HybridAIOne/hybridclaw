# Tool lookup latency checks

Use fresh conversations and real connector data for both prompts:

- `Welche Proteinriegel im dm haben den höchsten Proteingehalt absolut in g?`
- `Welche Aktionen gibt es gerade bei dm?`

Run the checkout-local worker through authenticated IPC with the same provider,
model, workspace prompt and MCP configuration as the running gateway. Repeat
fresh histories in one worker to distinguish connection startup from warm turns.
Use the gateway's streamed `/api/chat` tool events for an end-to-end comparison.
Do not restart the gateway or change its configured model for these checks.

Record wall time, model response count and duration, individual tool durations,
overlap, prompt tokens and answer correctness. Audit events flushed at turn end
are not reliable tool start timestamps. A fast wrong answer fails the benchmark.
File references in worker output are IPC transport; inspect the saved result or
restore it on the gateway before measuring result size or checking evidence.

## Observations, 2026-10-03

The first inline-schema patch's gateway rerun took 17.1 seconds and five model
responses, including a correction because catalog listing required `name`.
Isolated worker repeats took 11.9–18.1 seconds. Connector reads themselves took
roughly 0.4–0.9 seconds each; model round trips dominated.

With complete tool results, compact discovery and prompt formatting, five
isolated repeats took 9.3–11.8 seconds and returned the correct 27 g winner.
Three used three model responses; two used four. This approaches the target
but does not establish a consistent 5–10 second guarantee. More aggressive
skill-description shortening produced incorrect rankings and was discarded.
A separate two-search probe confirmed live concurrent dm reads (0.48 and
0.52 seconds), with a 6.2-second complete turn.

Promotions are outside the discovered dm connector's product/store scope.
The page returned HTTP 200 with an empty app shell and a reCAPTCHA script,
which incorrectly triggered `bot_blocked`. Visible-text classification fixes
that hint. Successful browser runs with the shorter prompt took 17.9–25.4
seconds; browser navigation took 4.0–7.4 seconds. This query needs further
optimization before meeting the latency target. These runs preceded removal
of the per-result preview cap and the final conservative prompt formatting.
