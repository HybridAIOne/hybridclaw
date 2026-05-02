import {
  type ButtonHTMLAttributes,
  type ComponentType,
  type InputHTMLAttributes,
  type ReactNode,
  useMemo,
  useState,
} from 'react';
import type { GatewayModelProviderKey } from '../../../../src/gateway/gateway-types.js';
import type { ChatModel } from '../../api/types';
import {
  Local as LocalIcon,
  Menu,
  Search as SearchIcon,
  Server as ServerIcon,
} from '../../components/icons';
import {
  AlibabaLogo,
  AnthropicLogo,
  CodexLogo,
  DashScopeLogo,
  DeepSeekLogo,
  GeminiLogo,
  HuggingFaceLogo,
  HybridAILogo,
  KiloLogo,
  KimiLogo,
  LlamaCppLogo,
  LMStudioLogo,
  MetaLogo,
  MicrosoftLogo,
  MiniMaxLogo,
  MistralLogo,
  OllamaLogo,
  OpenAILogo,
  OpenRouterLogo,
  type ProviderLogoProps,
  VLLMLogo,
  XaiLogo,
  XiaomiLogo,
  ZaiLogo,
} from '../../components/icons/providers';
import {
  Select,
  SelectContent,
  SelectEmpty,
  SelectGroup,
  SelectGroupLabel,
  SelectIcon,
  SelectItem,
  SelectItemBody,
  SelectItemMeta,
  SelectItemSubtitle,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from '../../components/select';
import { cx } from '../../lib/cx';
import { formatCompactNumber } from '../../lib/format';
import css from './chat-page.module.css';
import chrome from './model-switch-select.module.css';

export type ModelSwitchEntry = ChatModel;

export interface ParsedModel {
  id: string;
  groupLabel: string;
  providerRank: number;
  vendorRank: number;
  shortName: string;
  displayName: string;
  vendor: string | null;
  provider: string;
  meta: ModelSwitchEntry;
}

type KnownProvider =
  | 'Local'
  | 'HybridAI'
  | 'OpenAI Codex'
  | 'Anthropic'
  | 'OpenRouter'
  | 'Mistral'
  | 'Hugging Face'
  | 'Gemini'
  | 'DeepSeek'
  | 'xAI'
  | 'Z.ai'
  | 'Kimi'
  | 'MiniMax'
  | 'DashScope'
  | 'Xiaomi'
  | 'Kilo'
  | 'Ollama'
  | 'LM Studio'
  | 'llama.cpp'
  | 'vLLM';

// `Record<GatewayModelProviderKey, …>` makes the compiler flag any new gateway
// provider that ships without an explicit display label — without it, new
// providers silently fall through to the kebab-to-Title fallback in pretty().
const PROVIDER_LABELS: Record<GatewayModelProviderKey, KnownProvider> = {
  hybridai: 'HybridAI',
  codex: 'OpenAI Codex',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  mistral: 'Mistral',
  huggingface: 'Hugging Face',
  gemini: 'Gemini',
  deepseek: 'DeepSeek',
  xai: 'xAI',
  zai: 'Z.ai',
  kimi: 'Kimi',
  minimax: 'MiniMax',
  dashscope: 'DashScope',
  xiaomi: 'Xiaomi',
  kilo: 'Kilo',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  llamacpp: 'llama.cpp',
  vllm: 'vLLM',
};

const VENDOR_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  google: 'Google',
  openai: 'OpenAI',
  mistral: 'Mistral',
  meta: 'Meta',
  deepseek: 'DeepSeek',
  xai: 'xAI',
};

const PROVIDER_RANK: Partial<Record<KnownProvider, number>> = {
  Local: 0,
  HybridAI: 1,
  'OpenAI Codex': 2,
};

const VENDOR_ORDER: Record<string, number> = {
  Anthropic: 1,
  OpenAI: 2,
  Google: 3,
  Mistral: 4,
  Meta: 5,
};

function pretty(slug: string, table: Record<string, string>): string {
  const key = slug.toLowerCase();
  if (table[key]) return table[key];
  return slug
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

const ACRONYMS = new Set(['gpt', 'ai', 'ml', 'vl', 'ui', 'pdf', 'sdk', 'api']);
const BRAND_OVERRIDES: Record<string, string> = {
  deepseek: 'DeepSeek',
  openai: 'OpenAI',
  hybridai: 'HybridAI',
};
// Single-letter + digits like "o1"/"o3" — vendor-styled lowercase, leave alone.
const LOWERCASE_PRESERVED = /^[a-z]\d+$/;

function prettifyToken(token: string): string {
  const lower = token.toLowerCase();
  if (ACRONYMS.has(lower)) return lower.toUpperCase();
  if (BRAND_OVERRIDES[lower]) return BRAND_OVERRIDES[lower];
  if (LOWERCASE_PRESERVED.test(lower)) return lower;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * Turn a kebab-cased model slug into a human label.
 *   "claude-haiku-4-5"            -> "Claude Haiku 4.5"
 *   "claude-opus-4-1-20250805"    -> "Claude Opus 4.1" (drops date stamp)
 *   "claude-3-7-sonnet"           -> "Claude 3.7 Sonnet"
 *   "gpt-4.1-mini"                -> "GPT-4.1 Mini"
 *   "gemini-3-flash"              -> "Gemini 3 Flash"
 *   "deepseek-r1"                 -> "DeepSeek r1"
 *   "o3"                          -> "o3"
 */
function prettifyModelName(slug: string): string {
  if (!slug) return slug;
  const segments = slug.split('-').filter((seg) => !/^\d{5,}$/.test(seg));
  const out: string[] = [];
  let prevSegLower: string | null = null;
  let i = 0;
  while (i < segments.length) {
    const seg = segments[i];
    let token: string;
    let isVersionLike = false;
    if (/^\d+$/.test(seg)) {
      const nums: string[] = [seg];
      while (i + 1 < segments.length && /^\d+$/.test(segments[i + 1])) {
        i++;
        nums.push(segments[i]);
      }
      token = nums.join('.');
      isVersionLike = true;
    } else {
      token = prettifyToken(seg);
      isVersionLike = /^\d/.test(seg);
    }
    if (isVersionLike && prevSegLower && ACRONYMS.has(prevSegLower)) {
      const prev = out.pop() ?? '';
      out.push(prev ? `${prev}-${token}` : token);
    } else {
      out.push(token);
    }
    prevSegLower = segments[i].toLowerCase();
    i++;
  }
  return out.join(' ');
}

function railKeyOf(model: ParsedModel): string {
  return model.provider;
}

function inferProviderKeyForSelectedModel(modelId: string): string {
  const prefix = modelId.split('/', 1)[0]?.trim().toLowerCase() ?? '';
  if (prefix === 'openai-codex') return 'codex';
  if (prefix && PROVIDER_LABELS[prefix as GatewayModelProviderKey]) {
    return prefix;
  }
  return 'hybridai';
}

function inferBackendForSelectedModel(
  provider: string,
): ModelSwitchEntry['backend'] {
  if (provider === 'ollama') return 'ollama';
  if (provider === 'lmstudio') return 'lmstudio';
  if (provider === 'llamacpp') return 'llamacpp';
  if (provider === 'vllm') return 'vllm';
  return null;
}

function buildSelectedModelFallback(modelId: string): ModelSwitchEntry | null {
  const id = modelId.trim();
  if (!id) return null;
  const provider = inferProviderKeyForSelectedModel(id);
  const backend: ModelSwitchEntry['backend'] =
    inferBackendForSelectedModel(provider);
  return {
    id,
    provider,
    backend,
    contextWindow: null,
    isReasoning: false,
    family: null,
    parameterSize: null,
  };
}

type LogoComponent = ComponentType<ProviderLogoProps>;

const PROVIDER_LOGOS: Partial<Record<KnownProvider, LogoComponent>> = {
  HybridAI: HybridAILogo,
  'OpenAI Codex': CodexLogo,
  Anthropic: AnthropicLogo,
  OpenRouter: OpenRouterLogo,
  Mistral: MistralLogo,
  'Hugging Face': HuggingFaceLogo,
  Gemini: GeminiLogo,
  DeepSeek: DeepSeekLogo,
  xAI: XaiLogo,
  'Z.ai': ZaiLogo,
  Kimi: KimiLogo,
  MiniMax: MiniMaxLogo,
  DashScope: DashScopeLogo,
  Xiaomi: XiaomiLogo,
  Kilo: KiloLogo,
  Ollama: OllamaLogo,
  'LM Studio': LMStudioLogo,
  'llama.cpp': LlamaCppLogo,
  vLLM: VLLMLogo,
  Local: LocalIcon as LogoComponent,
};

const VENDOR_LOGOS: Record<string, LogoComponent> = {
  Anthropic: AnthropicLogo,
  OpenAI: OpenAILogo,
  Google: GeminiLogo,
  Mistral: MistralLogo,
  Meta: MetaLogo,
  DeepSeek: DeepSeekLogo,
  xAI: XaiLogo,
  Alibaba: AlibabaLogo,
  Microsoft: MicrosoftLogo,
};

function ProviderIcon({
  provider,
  size = 18,
}: {
  provider: string;
  size?: number;
}) {
  const Logo = PROVIDER_LOGOS[provider as KnownProvider];
  if (Logo) return <Logo width={size} height={size} />;
  return <ServerIcon width={size} height={size} />;
}

function VendorIcon({
  vendor,
  fallbackProvider,
  size = 18,
}: {
  vendor: string | null;
  fallbackProvider: string;
  size?: number;
}) {
  const Logo = vendor ? VENDOR_LOGOS[vendor] : undefined;
  if (Logo) return <Logo width={size} height={size} />;
  return <ProviderIcon provider={fallbackProvider} size={size} />;
}

interface SearchProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> {
  value: string;
  onValueChange: (value: string) => void;
}

function Search({
  value,
  onValueChange,
  className,
  placeholder = 'Search…',
  ...rest
}: SearchProps) {
  return (
    <div className={cx(chrome.search, className)}>
      <SearchIcon width="14" height="14" />
      <input
        type="text"
        autoComplete="off"
        spellCheck={false}
        className={chrome.searchInput}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        {...rest}
      />
    </div>
  );
}

function Rail({ children }: { children: ReactNode }) {
  return (
    <div role="toolbar" aria-orientation="vertical" className={chrome.rail}>
      {children}
    </div>
  );
}

interface RailItemProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onSelect'> {
  active?: boolean;
  label: string;
  color?: string;
  icon?: ReactNode;
}

function RailItem({
  active = false,
  label,
  color,
  icon,
  className,
  ...rest
}: RailItemProps) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={label}
      title={label}
      data-active={active ? '' : undefined}
      className={cx(chrome.railItem, className)}
      {...rest}
    >
      <span
        aria-hidden="true"
        className={chrome.railGlyph}
        style={color ? { color } : undefined}
      >
        {icon ?? label.charAt(0).toUpperCase()}
      </span>
    </button>
  );
}

const VENDOR_BY_PREFIX: ReadonlyArray<readonly [string, string]> = [
  ['claude', 'Anthropic'],
  ['gpt', 'OpenAI'],
  ['o1', 'OpenAI'],
  ['o3', 'OpenAI'],
  ['o4', 'OpenAI'],
  ['gemini', 'Google'],
  ['mistral', 'Mistral'],
  ['grok', 'xAI'],
  ['llama', 'Meta'],
  ['codellama', 'Meta'],
  ['deepseek', 'DeepSeek'],
  ['qwen', 'Alibaba'],
  ['phi', 'Microsoft'],
];

function inferVendor(name: string): string | null {
  const n = name.toLowerCase();
  return VENDOR_BY_PREFIX.find(([prefix]) => n.startsWith(prefix))?.[1] ?? null;
}

export function parseModel(entry: ModelSwitchEntry): ParsedModel {
  const id = entry.id;
  const parts = id.split('/');
  // Always trust the gateway-tagged provider over the id prefix — `parts[0]`
  // can be the id prefix (`openai-codex`) while `entry.provider` carries the
  // canonical providerHealth key (`codex`) that PROVIDER_LABELS is keyed by.
  const provider = pretty(entry.provider, PROVIDER_LABELS);
  let vendor: string | null;
  let shortName: string;

  if (parts.length === 1) {
    vendor = inferVendor(parts[0]);
    shortName = parts[0];
  } else if (parts.length === 2) {
    vendor = inferVendor(parts[1]);
    shortName = parts[1];
  } else {
    vendor = pretty(parts[1], VENDOR_LABELS);
    shortName = parts.slice(2).join('/');
  }

  const groupLabel = vendor ? `${provider} · ${vendor}` : provider;
  const providerRank = PROVIDER_RANK[provider as KnownProvider] ?? 50;
  const vendorRank = vendor ? (VENDOR_ORDER[vendor] ?? 50) : 0;

  return {
    id,
    groupLabel,
    providerRank,
    vendorRank,
    shortName,
    displayName: prettifyModelName(shortName),
    vendor,
    provider,
    meta: entry,
  };
}

function compareGroupRank(a: ParsedModel, b: ParsedModel): number {
  if (a.providerRank !== b.providerRank) return a.providerRank - b.providerRank;
  if (a.vendorRank !== b.vendorRank) return a.vendorRank - b.vendorRank;
  return a.groupLabel.localeCompare(b.groupLabel);
}

function formatContext(tokens: number | null): string | null {
  if (!tokens || tokens <= 0) return null;
  return formatCompactNumber(tokens);
}

function formatSubtitle(model: ParsedModel): string | null {
  // Prefer parameter size for local models (it's the most disambiguating bit
  // when an Ollama install has llama-3.1:8b alongside llama-3.1:70b); for
  // hosted models the family slug is the next-most-useful tag.
  const family = model.meta.family;
  const familyLabel =
    family && family !== model.shortName ? prettifyModelName(family) : null;
  const parts = [
    model.meta.parameterSize?.trim() || null,
    familyLabel && familyLabel !== model.displayName ? familyLabel : null,
    model.vendor,
  ].filter((part): part is string => Boolean(part));
  if (parts.length === 0) return null;
  return parts.join(' · ');
}

function modelMatchesQuery(model: ParsedModel, query: string): boolean {
  if (!query) return true;
  const haystack = [
    model.id,
    model.shortName,
    model.displayName,
    model.provider,
    model.vendor ?? '',
    model.groupLabel,
  ]
    .join(' ')
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => haystack.includes(token));
}

export function ModelSwitchSelect(props: {
  models: ModelSwitchEntry[];
  selectedModelId: string;
  disabled?: boolean;
  onSwitch: (modelId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [railFilter, setRailFilter] = useState<string | null>(null);

  const parsed = useMemo(() => props.models.map(parseModel), [props.models]);

  const railEntries = useMemo(() => {
    const counts = new Map<string, number>();
    for (const model of parsed) {
      const key = railKeyOf(model);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }, [parsed]);

  const groups = useMemo(() => {
    const filtered = parsed.filter((m) => {
      if (!modelMatchesQuery(m, query)) return false;
      if (railFilter && railKeyOf(m) !== railFilter) return false;
      return true;
    });
    const map = new Map<string, { head: ParsedModel; items: ParsedModel[] }>();
    for (const model of filtered) {
      let bucket = map.get(model.groupLabel);
      if (!bucket) {
        bucket = { head: model, items: [] };
        map.set(model.groupLabel, bucket);
      }
      bucket.items.push(model);
    }
    const ordered = Array.from(map.values()).sort((a, b) =>
      compareGroupRank(a.head, b.head),
    );
    for (const group of ordered) {
      group.items.sort((a, b) => a.shortName.localeCompare(b.shortName));
    }
    return ordered;
  }, [parsed, query, railFilter]);

  const selectedModelId = props.selectedModelId.trim();
  const selectedFallback = buildSelectedModelFallback(selectedModelId);
  const selected =
    parsed.find((m) => m.id === selectedModelId) ??
    (selectedFallback ? parseModel(selectedFallback) : undefined);

  if (props.models.length === 0 && !selected) return null;

  return (
    <Select
      value={selected ? selected.id : ''}
      disabled={props.disabled}
      onValueChange={(next) => {
        if (!next || next === selectedModelId) return;
        props.onSwitch(next);
      }}
    >
      <SelectTrigger
        aria-label="Switch model"
        title="Switch model"
        className={cx(css.composerPill, chrome.triggerPill)}
      >
        {selected ? (
          <span aria-hidden="true" className={chrome.triggerLogo}>
            <VendorIcon
              vendor={selected.vendor}
              fallbackProvider={selected.provider}
              size={16}
            />
          </span>
        ) : null}
        <SelectValue placeholder="Select model">
          {selected ? selected.displayName : ''}
        </SelectValue>
        <SelectIcon />
      </SelectTrigger>
      <SelectContent
        align="start"
        header={
          <Search
            value={query}
            onValueChange={setQuery}
            placeholder="Search models…"
            aria-label="Search models"
          />
        }
        rail={
          <Rail>
            <RailItem
              label={railFilter === null ? 'All providers' : 'Clear filter'}
              active={railFilter === null}
              icon={<Menu width="16" height="16" />}
              onClick={() => setRailFilter(null)}
            />
            {railEntries.map(({ key, count }) => (
              <RailItem
                key={key}
                label={`${key} (${count})`}
                active={railFilter === key}
                icon={<ProviderIcon provider={key} />}
                onClick={() =>
                  setRailFilter((prev) => (prev === key ? null : key))
                }
              />
            ))}
          </Rail>
        }
      >
        {groups.length === 0 ? (
          <SelectEmpty>No models match “{query}”.</SelectEmpty>
        ) : (
          groups.map((group) => (
            <SelectGroup key={group.head.groupLabel}>
              <SelectGroupLabel>{group.head.groupLabel}</SelectGroupLabel>
              {group.items.map((model) => {
                const ctx = formatContext(model.meta.contextWindow);
                const subtitle = formatSubtitle(model);
                return (
                  <SelectItem
                    key={model.id}
                    value={model.id}
                    textValue={`${model.displayName} ${model.groupLabel}`}
                  >
                    <span aria-hidden="true" className={chrome.itemLogo}>
                      <VendorIcon
                        vendor={model.vendor}
                        fallbackProvider={model.provider}
                        size={18}
                      />
                    </span>
                    <SelectItemBody>
                      <SelectItemText>{model.displayName}</SelectItemText>
                      {subtitle ? (
                        <SelectItemSubtitle>{subtitle}</SelectItemSubtitle>
                      ) : null}
                    </SelectItemBody>
                    <SelectItemMeta>
                      {ctx ? <span>{ctx}</span> : null}
                    </SelectItemMeta>
                  </SelectItem>
                );
              })}
            </SelectGroup>
          ))
        )}
      </SelectContent>
    </Select>
  );
}
