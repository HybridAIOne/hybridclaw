---
title: Current Local Model Shortlist
description: Publisher artifacts, Mac installability and memory assumptions for the user-selected model shortlist.
---

# Current Local Model Shortlist

Reviewed 2026-09-10 against the supplied Twitter shortlist, publisher files and
runtime source. The setup catalog includes all twelve entries. Automatic setup
uses Spark, Ternary Bonsai, Qwen3.8 27B and Nex Mini; every activation requires
local streaming and tool checks. The other entries remain visible with the
specific limitation below. The earlier Qwen3 4B/8B defaults are removed.

The post's numbers describe GPU VRAM tiers, not Mac unified-memory requirements.
A Mac also needs room for macOS, running apps, caches and prefill. EXL3 and MLX
are different formats. The chosen Mac artifact is named explicitly; no EXL3
quality claim is transferred to an MLX conversion.

| Shortlist entry | Post: GB VRAM | Inspected artifact | Weight bytes / status |
| --- | --- | --- | --- |
| [Spark-X2.5 4B](https://huggingface.co/XHToken/Spark-X2.5-4B) | 8 | [abenzerps/Spark-X2.5-4B-MLX-4bit](https://huggingface.co/abenzerps/Spark-X2.5-4B-MLX-4bit/tree/b23819d4d60c2767fbf6ee3b3527f5f33205be7e) | 2.31 GB. Managed Mac installation candidate; local checks required. |
| [Ternary Bonsai 27B](https://huggingface.co/prism-ml/Ternary-Bonsai-27B-gguf) | 8 | [prism-ml/Ternary-Bonsai-27B-mlx-2bit](https://huggingface.co/prism-ml/Ternary-Bonsai-27B-mlx-2bit/tree/70f75f3ad081ab840a42f3304c02c27e7f89bfb7) | 8.49 GB. Managed Mac installation candidate; local checks required. |
| [Gemma 4 12B](https://huggingface.co/google/gemma-4-12B-it) | 16 | [mlx-community/gemma-4-12B-it-4bit](https://huggingface.co/mlx-community/gemma-4-12B-it-4bit/tree/73bcf09092aa277861d5a191b989b666f7f32e8f) | 6.74 GB. Requires Gemma unified-model support and a vision runtime; this installer is text-only. |
| [Qwen3.8 27B](https://huggingface.co/Qwen/Qwen3.8-27B) | 24 | [mlx-community/Qwen3.8-27B-4bit](https://huggingface.co/mlx-community/Qwen3.8-27B-4bit/tree/3e6447f082e89cc7f0bc6e5441afd38dfce760ff) | 16.05 GB. Managed Mac installation candidate; local checks required. |
| [Nex-N2.5 Mini](https://huggingface.co/nex-agi/Nex-N2.5-mini) | 32–64 | [abenzerps/Nex-N2.5-mini-MLX-4bit](https://huggingface.co/abenzerps/Nex-N2.5-mini-MLX-4bit/tree/98d82d7d030ff5e438b146c3957cba9e371ed01e) | 19.51 GB. Managed Mac installation candidate; local checks required. |
| [Qwen3.8 Flash Next](https://huggingface.co/Qwen/Qwen3.8-Flash-Next) | 96–128 | [mlx-community/Qwen3.8-Flash-Next-4bit](https://huggingface.co/mlx-community/Qwen3.8-Flash-Next-4bit/tree/07b5dc6c54600a359b87f1e53e7adf6351c72a2c) | 111.52 GB. Requires a newer MLX vision runtime; its full 111.5 GB artifact also needs more RAM than the listed offload scenario. |
| [GLM-5.3 Flash · EXL3 2 bpw](https://huggingface.co/0xSero/GLM-5.3-Flash-EXL3-TR3-2.0bpw) | 96–128 | [0xSero/GLM-5.3-Flash-EXL3-TR3-2.0bpw](https://huggingface.co/0xSero/GLM-5.3-Flash-EXL3-TR3-2.0bpw/tree/35b4b580debe2a1510a2eb042d9d6d4cd7fb3a6b) | 111.35 GB. EXL3 requires a compatible GPU runtime; this artifact cannot be installed in MLX. |
| [GLM-5.3 Flash · EXL3 4 bpw](https://huggingface.co/0xSero/GLM-5.3-Flash-EXL3-Q4) | 196–256 | [0xSero/GLM-5.3-Flash-EXL3-Q4](https://huggingface.co/0xSero/GLM-5.3-Flash-EXL3-Q4/tree/d0b9301a10da765df1d76571107577041009f28d) | 187.45 GB. EXL3 cannot load in MLX; the available MLX conversion also requires a separate patched runtime. |
| [DeepSeek V4 Flash Vision Exp](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash-Vision-Exp) | 196–256 | [Solstice-AI/DeepSeek-V4-Flash-Vision-Exp-MLX](https://huggingface.co/Solstice-AI/DeepSeek-V4-Flash-Vision-Exp-MLX/tree/2b5355ae0446fafe69fc186cf2bc62f6d803d5af) | 170.11 GB. Requires DeepSeek V4 and vision support absent from the pinned inference runtime. |
| [GLM-5.3 · REAP EXL3 3 bpw](https://huggingface.co/0xSero/GLM-5.3-500B-EXL3-3.0bpw) | 196–256 | [0xSero/GLM-5.3-500B-EXL3-3.0bpw](https://huggingface.co/0xSero/GLM-5.3-500B-EXL3-3.0bpw/tree/bada39f0ae0d6d9c7e3f8c14d368a5bacf5d5401) | 197.04 GB. EXL3 requires another runtime; the post does not identify which REAP expert count. |
| [Nex-N2.5 Pro](https://huggingface.co/nex-agi/Nex-N2.5-Pro) | 196–256 | [nex-agi/Nex-N2.5-Pro](https://huggingface.co/nex-agi/Nex-N2.5-Pro/tree/937d21d8427046d51cc919bad795b9de71000635) | Not published. The publisher repository says weights are coming soon; no weights are available to install. |
| [GLM-5.3](https://huggingface.co/zai-org/GLM-5.3) | 384–512 | [pipenetwork/GLM-5.3-MLX-mixed-3_6bit](https://huggingface.co/pipenetwork/GLM-5.3-MLX-mixed-3_6bit/tree/4c4ce289cd0b7815dd7b30af3d0320647feb8fd9) | 332.58 GB. The 332.6 GB MLX conversion requires a patched sparse-attention implementation not bundled here. |

## Recommendation and runtime rules

On an otherwise idle supported Mac, the current estimates select Spark at
8 GiB, Bonsai at 16 GiB, Qwen3.8 27B at 24 GiB, and Nex Mini at 32–64 GiB.
Current memory availability can select a smaller candidate. On a larger Mac,
the installer still selects only a supported candidate; it never downloads an
unsupported model just because its weights would fit. The desktop's **View full
shortlist…** action explains why the larger entries are not offered for install.

The Spark model implementation comes from the publisher's
[Spark-MLX-LLM commit](https://github.com/XHToken/Spark-MLX-LLM/tree/de2b4379fa1e2f2e1f99d84c83f0e008f651d86c).
The dependency source archive and SHA-256 are locked. Spark's exact quantized
checkpoint retains its Transformers `auto_map`, which is accepted as inert
metadata only for that pinned repo/revision and exact mapping. The separately
installed implementation is registered with MLX-LM. Checkpoint Python is excluded
from downloads, arbitrary `auto_map`/`model_file` values remain rejected, and
`trust_remote_code` stays false. Another revision needs a new review.

The GLM REAP link in the post is abbreviated and does not identify the number of
retained experts. The table records a verified 500B cut as a reference; it is not
silently selected over 569B or another cut. Nex Pro's publisher repository
contains an announcement and images, with no downloadable weights.

New architecture ports need their own integration and tests. In particular,
[Qwen Flash Next's conversion notes](https://huggingface.co/mlx-community/Qwen3.8-Flash-Next-4bit)
identify a norm-conversion correction;
[GLM Flash's notes](https://huggingface.co/pipenetwork/GLM-5.3-Flash-MLX-4bit)
require a patched runtime; and
[GLM-5.3's notes](https://huggingface.co/pipenetwork/GLM-5.3-MLX-mixed-3_6bit)
explain the sparse-indexer schedule absent from the pinned stock implementation.
These checks prevent a model-name match from being mistaken for correct execution.

## Validation

Spark's pinned 4-bit artifact passed a real run on an Apple M5 with 32 GiB
unified memory and a 4,096-token context. The
[raw qualification report](mac-shortlist-smoke.json) records 255 ms to the first
generated token (including reasoning), 31.6 effective decode tokens/s, a passing
tool round trip and all twelve boundary checks. Peak memory after those checks
was 2.69 GiB. This single run includes HTTP overhead and is not a quality or
device-matrix benchmark.

Spark uses its publisher's default reasoning mode. With reasoning disabled it
fabricated a tool result during qualification; with reasoning enabled it emitted
the actual tool call and consumed the returned random marker. The streaming probe
allows up to 512 output tokens within the installed budget and requires visible
output, usage and stream completion. Its first-token timer includes reasoning;
it does not treat time spent reasoning as prefill time.

Memory tests cover the current shortlist's supported choices, busy machines,
8 GiB Bonsai rejection, unpublished weights represented as unknown rather than
zero-size, and large-memory machines never selecting unsupported entries.
Desktop tests exercise the full-shortlist view without starting installation.
Python tests bind Spark's metadata exception to the exact checkpoint and reject
changed revisions, arbitrary code mappings, tokenizer code and `model_file`.
Process-start tests reject removed model IDs and mismatched artifact pins before
launch. Streaming tests reject reasoning-only, unmetered and incomplete responses.

The [initial phase-1 measurements](mac-inference-qualification.md) remain a
historical Qwen3 baseline; they are not performance claims for the new catalog.
The Bonsai and Nex Mini artifacts have been inspected for format, architecture
and memory compatibility but have not been downloaded or GPU-qualified in this
update. Device-matrix benchmarks and vision runtime integrations remain pending.
The active gateway and user model
configuration are not changed by editing the shortlist.
