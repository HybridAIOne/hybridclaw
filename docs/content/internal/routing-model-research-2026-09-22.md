# Routing model research — 22 September 2026

The recommended capability bands are **basic, economy, general, advanced**.
Assignments are an engineering judgment based on the evidence below, not benchmark
publisher classifications. Keep alternatives within a band; retry-safe failures
escalate to the next band.

## Comparison

Prices are USD per million input / output tokens, excluding cache, tools and taxes.
The route-price column uses the live HybridAI catalog, except the configured Gemma
and Qwen endpoints, which retain the operator's existing rates. These are advertised
rates, not a verified invoice. Do not add another 10% to an already configured rate.

Scores use Artificial Analysis Intelligence Index **v4.3.2**, as retrieved on
22 September 2026. They are index points, not percentages. GPT and Claude rows use
**max effort**; Fable 5.1 includes its default fallback. Qwen is the reasoning
variant; Gemma is non-reasoning and its score is an AA estimate. These benchmark
conditions do not establish the score of an unspecified HybridAI reasoning setting
or a quantized deployment. No reasoning settings were changed as part of assignment.

Speed is public benchmark output throughput, **not measured HybridAI throughput**.
The last column shows AA's reported first-token delay at the tested effort; high
throughput alone does not imply a short wait for an answer.

| Model / source | Score | Output tokens/s | Advertised route input / output | Public API input / output | First-token delay (s) |
| --- | ---: | ---: | ---: | ---: | ---: |
| [Gemma 4 E4B, non-reasoning](https://artificialanalysis.ai/models/gemma-4-e4b-non-reasoning) | 7, estimated | 43.0 | 0.22 / 0.22, configured endpoint | 0.02 / 0.10 | 0.80 |
| [Qwen 3.6 27B, reasoning](https://artificialanalysis.ai/models/qwen3-6-27b) | 21 | 58.8 | 0.33 / 2.20, configured endpoint; 0.3112 / 3.1117 via HybridAI | 0.60 / 3.60 | 3.64 |
| [GPT-5.6 Luna, max](https://artificialanalysis.ai/models/gpt-5-6-luna) | 37 | 158.7 | 0.1915 / 1.1489 | 0.20 / 1.20 | 123.28 |
| [Claude Sonnet 5, max](https://artificialanalysis.ai/models/claude-sonnet-5) | 38 | 77.3 | 1.9149 / 9.5744 | 2.00 / 10.00 | 141.26 |
| [GPT-5.6 Terra, max](https://artificialanalysis.ai/models/gpt-5-6-terra) | 42 | 104.6 | 1.9149 / 11.4893 | 2.00 / 12.00 | 223.75 |
| [GPT-5.6 Sol, max](https://artificialanalysis.ai/models/gpt-5-6-sol) | 47 | 84.2 | 3.8298 / 19.1488 | 4.00 / 20.00 | 124.25 |
| [Claude Opus 5, max](https://artificialanalysis.ai/models/claude-opus-5) | 51 | 56.4 | 4.7872 / 23.9359 | 5.00 / 25.00 | 49.25 |
| [Claude Fable 5.1, max with fallback](https://artificialanalysis.ai/models/claude-fable-5-1) | 53 | 65.8 | Exact version absent | 10.00 / 50.00 | 298.45 |
| [GPT-6 Astra, max](https://artificialanalysis.ai/models/gpt-6-astra) | 53 | 65.3 | Absent | 10.00 / 50.00 | 259.33 |

Astra is GPT-6, not GPT-5.6. Current official OpenAI pricing confirms
[Luna](https://developers.openai.com/api/docs/models),
[Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra), and
[Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol).
The July launch article has older prices; use current model documentation and the
actual serving catalog instead.

The HybridAI discovery API advertises `claude-fable-5`, not `claude-fable-5-1`.
[Fable 5's separate benchmark](https://artificialanalysis.ai/models/claude-fable-5)
is 50 points, about 68 tokens/s, and uses an Opus 4.8 fallback. It is not evidence
that this endpoint serves Fable 5.1; no substitution was made. HybridAI's Gemma entry
is Gemma 4 **26B**, not E4B, so the existing E4B endpoint is retained.

## Tier assignments

| Band | Models | Rationale |
| --- | --- | --- |
| Basic | Gemma 4 E4B | Simple short writing, extraction and everyday prompts; lowest benchmark capability here. |
| Economy | Qwen 3.6 27B | A distinct open-weight capability step above E4B. Use the configured haigpu1 endpoint once; the HybridAI endpoint is the same model, not a separate model backup. |
| General | Luna, Sonnet 5, Terra | General writing, coding, research and analysis; 37–42 at tested max effort. |
| Advanced | Sol, Opus 5 | Complex analysis and difficult coding; 47–51 at tested max effort. |
| Advanced, pending availability | Astra, Fable 5.1 | 53 at tested settings; do not add until the exact endpoint IDs are verified. |

Auto starts General with Luna, followed by Terra and Sonnet. Cost orders those
alternatives Luna, Sonnet, Terra by advertised rates. Speed uses Luna, Terra,
Sonnet as an initial throughput-based ordering; real execution timing can override
that order. Sol precedes Opus in Advanced for initial cost/throughput balance.
This is not a claim that Sol has lower end-to-end latency than Opus at max effort.

Luna has lower advertised input and output rates than either configured Qwen
route, while scoring higher in these published tests. Cost routing can therefore
skip the Qwen band and select Luna directly when it satisfies the task. Qwen's
separate band remains useful for self-hosting and deployments with different prices.
Gemma's low output rate can still be attractive for simple output-heavy tasks.

All verified HybridAI entries and the configured remote Gemma/Qwen endpoints
advertise `cloud`. Privacy therefore has no evidence-based distinction among these
routes. Do not relabel them private because the weights are open or because
HybridAI is the gateway. Local-only remains a separate constraint; these cloud
assignments cannot satisfy it.

## Limits and verification

The live catalog confirms advertised IDs and prices, not successful inference,
quality equivalence, data residency contracts, or actual billing. No paid live
inference benchmark was run. Public throughput and scores are research evidence,
not injected measurements in the gateway's recent-latency cache. The existing
runtime continues to collect real successful execution times and uses configured
order when those are absent.

### Privacy limits

Operator classification (2026-09-22): the configured Gemma E4B and Qwen 27B
endpoints are HAI-hosted. Their earlier cloud classification above was incorrect.

The maximum permitted endpoint level replaces the local-only switch:
💻 Local → 🏢 HAI → 🇪🇺 DE/EU provider → 🇪🇺 DE/EU hosting → 🌐 World.
DE/EU provider means EU operator and EU hosting; DE/EU hosting allows a non-EU
operator. Unknown locations count as World. Endpoint zone keys are `local`,
`hai`, `eu-provider`, `region`, and `cloud`, respectively.

The limit bounds execution, live and comparison routers, manual model selections,
and fallback in every routing mode. Capability tiers remain separate. Invalid
saves are rejected if an enabled capability tier has no eligible path. These
checks restrict disclosure; they do not certify a provider's legal jurisdiction.

Operator classification (2026-09-22): OpenAI and Anthropic model routes through
HybridAI are DE/EU hosting. Direct OpenRouter, Anthropic, OpenAI/Codex and xAI
routes remain World. This is an operator-provided deployment classification,
not an inference from model authorship. Unclassified HybridAI models retain
catalog metadata; unknown locations remain World.

Operator classification (2026-09-22): Mistral direct and through HybridAI are
DE/EU provider; Mistral through OpenRouter remains World. Privacy previews prefer
configured capability models across equivalent routes, diversify model makers,
and omit old Claude 3, batch variants and duplicate aliases. This preview does
not change the saved execution tiers or remove entries from the full catalog.

Operator clarification (2026-09-22): no HybridAI route belongs to World.
HybridAI Qwen/Gemma are HAI-hosted; Mistral remains DE/EU provider, and other
HybridAI routes use DE/EU hosting. This overrides the earlier unknown-HybridAI
World fallback for this deployment.
