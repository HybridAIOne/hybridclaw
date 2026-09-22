/**
 * The user-selected shortlist is the source of local setup choices.
 * An artifact reference is not runtime support: unavailable entries stay visible
 * with a reason and can never reach the installer or automatic recommendation.
 */
export interface MacModelArtifact {
  repo: string;
  revision: string;
  license: string;
  weightBytes: number;
  kvBytesPerToken: number;
  fixedCacheBytes: number;
  maxContextWindow: number;
}
export interface LocalModelShortlistEntry {
  id: string;
  label: string;
  sourceRepo: string;
  listedMemoryGb: string;
  note: string;
  inspectedArtifact: {
    repo: string;
    revision: string;
    weightBytes: number | null;
  };
  installation: MacModelArtifact | null;
  unavailableReason: string | null;
}

// 2026-09-10, user-selected shortlist, reviewed by Codex against publisher files.
// Order follows the post's hardware tiers; claims of frontier parity are not scores.
// Unreviewed runtime ports and unreleased weights are explicitly deferred below.
export const LOCAL_MODEL_SHORTLIST: readonly LocalModelShortlistEntry[] = [
  {
    id: 'spark-x2.5-4b',
    label: 'Spark-X2.5 4B',
    sourceRepo: 'XHToken/Spark-X2.5-4B',
    listedMemoryGb: '8',
    note: '4-bit. Compact coding and tool candidate; pinned Spark runtime extension.',
    inspectedArtifact: {
      repo: 'abenzerps/Spark-X2.5-4B-MLX-4bit',
      revision: 'b23819d4d60c2767fbf6ee3b3527f5f33205be7e',
      weightBytes: 2313395808,
    },
    installation: {
      repo: 'abenzerps/Spark-X2.5-4B-MLX-4bit',
      revision: 'b23819d4d60c2767fbf6ee3b3527f5f33205be7e',
      license: 'apache-2.0',
      weightBytes: 2313395808,
      // Pinned Spark config/runtime, verified 2026-09-10: 9 full KV layers;
      // 27 rotating layers retain 512 tokens plus one 256-token prefill chunk.
      kvBytesPerToken: 9 * 2 * 4 * 256 * 2,
      fixedCacheBytes: 27 * 2 * 4 * 256 * 2 * (512 + 256),
      // Codex qualification ceiling, 2026-09-10; million-token use deferred.
      maxContextWindow: 40960,
    },
    unavailableReason: null,
  },
  {
    id: 'ternary-bonsai-27b',
    label: 'Ternary Bonsai 27B',
    sourceRepo: 'prism-ml/Ternary-Bonsai-27B-gguf',
    listedMemoryGb: '8',
    note: "2-bit MLX. Its weights alone exceed an 8 GiB Mac's safe model budget.",
    inspectedArtifact: {
      repo: 'prism-ml/Ternary-Bonsai-27B-mlx-2bit',
      revision: '70f75f3ad081ab840a42f3304c02c27e7f89bfb7',
      weightBytes: 8490785104,
    },
    installation: {
      repo: 'prism-ml/Ternary-Bonsai-27B-mlx-2bit',
      revision: '70f75f3ad081ab840a42f3304c02c27e7f89bfb7',
      license: 'apache-2.0',
      weightBytes: 8490785104,
      kvBytesPerToken: 65536,
      fixedCacheBytes: 0,
      maxContextWindow: 8192,
    },
    unavailableReason: null,
  },
  {
    id: 'gemma-4-12b',
    label: 'Gemma 4 12B',
    sourceRepo: 'google/gemma-4-12B-it',
    listedMemoryGb: '16',
    note: 'Vision candidate from the shortlist.',
    inspectedArtifact: {
      repo: 'mlx-community/gemma-4-12B-it-4bit',
      revision: '73bcf09092aa277861d5a191b989b666f7f32e8f',
      weightBytes: 6741039511,
    },
    installation: null,
    unavailableReason:
      'Requires Gemma unified-model support and a vision runtime; this installer is text-only.',
  },
  {
    id: 'qwen3.8-27b',
    label: 'Qwen3.8 27B',
    sourceRepo: 'Qwen/Qwen3.8-27B',
    listedMemoryGb: '24',
    note: '4-bit MLX alternative to the listed EXL3 build; text and tools here.',
    inspectedArtifact: {
      repo: 'mlx-community/Qwen3.8-27B-4bit',
      revision: '3e6447f082e89cc7f0bc6e5441afd38dfce760ff',
      weightBytes: 16054541349,
    },
    installation: {
      repo: 'mlx-community/Qwen3.8-27B-4bit',
      revision: '3e6447f082e89cc7f0bc6e5441afd38dfce760ff',
      license: 'apache-2.0',
      weightBytes: 16054541349,
      kvBytesPerToken: 65536,
      fixedCacheBytes: 0,
      maxContextWindow: 8192,
    },
    unavailableReason: null,
  },
  {
    id: 'nex-n2.5-mini',
    label: 'Nex-N2.5 Mini',
    sourceRepo: 'nex-agi/Nex-N2.5-mini',
    listedMemoryGb: '32–64',
    note: '4-bit MoE. Account for every resident expert, not only active parameters.',
    inspectedArtifact: {
      repo: 'abenzerps/Nex-N2.5-mini-MLX-4bit',
      revision: '98d82d7d030ff5e438b146c3957cba9e371ed01e',
      weightBytes: 19509024201,
    },
    installation: {
      repo: 'abenzerps/Nex-N2.5-mini-MLX-4bit',
      revision: '98d82d7d030ff5e438b146c3957cba9e371ed01e',
      license: 'apache-2.0',
      weightBytes: 19509024201,
      kvBytesPerToken: 20480,
      fixedCacheBytes: 0,
      maxContextWindow: 8192,
    },
    unavailableReason: null,
  },
  {
    id: 'qwen3.8-flash-next',
    label: 'Qwen3.8 Flash Next',
    sourceRepo: 'Qwen/Qwen3.8-Flash-Next',
    listedMemoryGb: '96–128',
    note: 'PLE/offload optimizations are not provided by this installer.',
    inspectedArtifact: {
      repo: 'mlx-community/Qwen3.8-Flash-Next-4bit',
      revision: '07b5dc6c54600a359b87f1e53e7adf6351c72a2c',
      weightBytes: 111519423247,
    },
    installation: null,
    unavailableReason:
      'Requires a newer MLX vision runtime; its full 111.5 GB artifact also needs more RAM than the listed offload scenario.',
  },
  {
    id: 'glm-5.3-flash-2bpw',
    label: 'GLM-5.3 Flash · EXL3 2 bpw',
    sourceRepo: '0xSero/GLM-5.3-Flash-EXL3-TR3-2.0bpw',
    listedMemoryGb: '96–128',
    note: "Preserves the shortlist's exact 2 bpw recommendation.",
    inspectedArtifact: {
      repo: '0xSero/GLM-5.3-Flash-EXL3-TR3-2.0bpw',
      revision: '35b4b580debe2a1510a2eb042d9d6d4cd7fb3a6b',
      weightBytes: 111352026456,
    },
    installation: null,
    unavailableReason:
      'EXL3 requires a compatible GPU runtime; this artifact cannot be installed in MLX.',
  },
  {
    id: 'glm-5.3-flash-4bpw',
    label: 'GLM-5.3 Flash · EXL3 4 bpw',
    sourceRepo: '0xSero/GLM-5.3-Flash-EXL3-Q4',
    listedMemoryGb: '196–256',
    note: "Preserves the shortlist's 4 bpw variant separately.",
    inspectedArtifact: {
      repo: '0xSero/GLM-5.3-Flash-EXL3-Q4',
      revision: 'd0b9301a10da765df1d76571107577041009f28d',
      weightBytes: 187453172472,
    },
    installation: null,
    unavailableReason:
      'EXL3 cannot load in MLX; the available MLX conversion also requires a separate patched runtime.',
  },
  {
    id: 'deepseek-v4-flash-vision',
    label: 'DeepSeek V4 Flash Vision Exp',
    sourceRepo: 'deepseek-ai/DeepSeek-V4-Flash-Vision-Exp',
    listedMemoryGb: '196–256',
    note: 'The verified upstream checkpoint is explicitly experimental.',
    inspectedArtifact: {
      repo: 'Solstice-AI/DeepSeek-V4-Flash-Vision-Exp-MLX',
      revision: '2b5355ae0446fafe69fc186cf2bc62f6d803d5af',
      weightBytes: 170114246101,
    },
    installation: null,
    unavailableReason:
      'Requires DeepSeek V4 and vision support absent from the pinned inference runtime.',
  },
  {
    id: 'glm-5.3-reap-3bpw',
    label: 'GLM-5.3 · REAP EXL3 3 bpw',
    sourceRepo: '0xSero/GLM-5.3-500B-EXL3-3.0bpw',
    listedMemoryGb: '196–256',
    note: '500B is a verified reference, not an automatic choice among REAP cuts.',
    inspectedArtifact: {
      repo: '0xSero/GLM-5.3-500B-EXL3-3.0bpw',
      revision: 'bada39f0ae0d6d9c7e3f8c14d368a5bacf5d5401',
      weightBytes: 197035264356,
    },
    installation: null,
    unavailableReason:
      'EXL3 requires another runtime; the post does not identify which REAP expert count.',
  },
  {
    id: 'nex-n2.5-pro',
    label: 'Nex-N2.5 Pro',
    sourceRepo: 'nex-agi/Nex-N2.5-Pro',
    listedMemoryGb: '196–256',
    note: 'Do not substitute hosted access for a local model.',
    inspectedArtifact: {
      repo: 'nex-agi/Nex-N2.5-Pro',
      revision: '937d21d8427046d51cc919bad795b9de71000635',
      weightBytes: null,
    },
    installation: null,
    unavailableReason:
      'The publisher repository says weights are coming soon; no weights are available to install.',
  },
  {
    id: 'glm-5.3',
    label: 'GLM-5.3',
    sourceRepo: 'zai-org/GLM-5.3',
    listedMemoryGb: '384–512',
    note: 'MLX 3/6-bit alternative inspected; it is not the listed EXL3 artifact.',
    inspectedArtifact: {
      repo: 'pipenetwork/GLM-5.3-MLX-mixed-3_6bit',
      revision: '4c4ce289cd0b7815dd7b30af3d0320647feb8fd9',
      weightBytes: 332578579798,
    },
    installation: null,
    unavailableReason:
      'The 332.6 GB MLX conversion requires a patched sparse-attention implementation not bundled here.',
  },
];
