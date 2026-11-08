# Production-source prompt check

Historical check of the first prompt/Gym commit
`300c9eba64ad85c4aff5fbebeb3e55f1a5cf4f2f`. Later multi-suite runs use revised
world/scorer/runner fingerprints and must not be pooled with this check.

2026-10-29, based on runtime revision
`1360759541d32fa89b428e155d53a180c7f3f80b`.
Model: `hybridai/gpt-6-luna`, using the production HybridAI provider adapter.
Only the mobile reply block changes; production safety and app output rules
remain in the compiled prompt. All mailbox, portal and action evidence is synthetic.

Reproduce from this checkout with the configured provider credential:

```sh
node --import tsx eval-harness/agent-gym/launch.mjs --variant candidate --scenario leasing,review-control,access-denied,benchmark-switch --runs 1 --judge
```

| Scenario | Deterministic checks | Observed result |
| --- | ---: | --- |
| Ordinary portal reply | 12/12 | Benchmark and configuration survive both draft versions; latest approved text sent once in simulation. |
| Review capability prototype | 13/13 | Both review bodies preserve the reference; latest approved text sent once in simulation. |
| Denied destination | 13/13 | Complete addressed draft and shorter revision appear in the reply despite denied placement. |
| Explicit reference change | 13/13 | Both versions use the user's replacement reference and retain it through simulated delivery. |

Total: 51/51 checks across four episodes. This is a focused compatibility check
after porting earlier tuning to current production source, not a new A/B result
or a general reliability estimate. Each scenario ran once. Earlier tuning runs
used a different compiled production prompt and must not be pooled with these.

The optional model judge passed 14/16 criteria. It flagged delivery-time coverage
in two drafts/revisions: one omitted the reference's waiting period, and one
short revision omitted an explicit request for the recipient's delivery time.
Both retained the price reference and required configuration. Preserve these
flags as review evidence; the deterministic total does not establish that every
useful term appeared in every draft.

Provenance:

- Candidate compiled prompt SHA-256: `473c10802e5bca80f6c1188a2e4b4e0d356ba64cf7d3624341a97547e3a3ab9e`
- Baseline compiled prompt SHA-256: `de2981669c3006ed26d3b38136d7da07bee51a84ab266cb923fbabd317103fc9`
- Prompt source SHA-256: `1d601628e88529e9054dfb060a21997eb540e10ea974efc86acba01db33cea4a`
- Dataset SHA-256: `6b19c03fb1c41e57cbfdf586af62d9595753e8ce252713bfa362df40ec4110a5`
- Simulated world SHA-256: `6abd8aac1d0b50e0f5fa64a588733bcd766a2247bf78494fd3bc098a094bc482`
- Scorer SHA-256: `ab315b0fd8103a5f8fb39b0b7f89d91d40a2b72d836b5a78b14e97f6b0af840c`

The runner records complete synthetic traces locally under ignored `results/`.
It does not exercise the production agent loop, live connectors, actual app
rendering or delivery. `review_action` remains an explicitly simulated prototype.
The seven families in `everyday-cases.json` are specifications awaiting runnable
worlds and scorers; no passing results are claimed for them.
