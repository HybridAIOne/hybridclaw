import { type ReactElement, useMemo, useState } from 'react';
import type { ChatModel } from '../../api/types';
import { Menu } from '../../components/icons';
import {
  Select,
  SelectBadge,
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
  SelectRail,
  SelectRailItem,
  SelectSearch,
  SelectTrigger,
  SelectValue,
} from '../../components/select';
import { formatCompactNumber } from '../../lib/format';

export type ModelSwitchEntry = ChatModel;

interface ParsedModel {
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

type KnownProvider = 'Local' | 'HybridAI' | 'OpenAI Codex';

const PROVIDER_LABELS: Record<string, KnownProvider> = {
  hybridai: 'HybridAI',
  'openai-codex': 'OpenAI Codex',
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

const PROVIDER_RANK: Record<KnownProvider, number> = {
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
 *   "claude-haiku-4-5"   -> "Claude Haiku 4.5"
 *   "claude-3-7-sonnet"  -> "Claude 3.7 Sonnet"
 *   "gpt-4.1-mini"       -> "GPT-4.1 Mini"
 *   "gemini-3-flash"     -> "Gemini 3 Flash"
 *   "deepseek-r1"        -> "DeepSeek r1"
 *   "o3"                 -> "o3"
 */
function prettifyModelName(slug: string): string {
  if (!slug) return slug;
  const segments = slug.split('-');
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

function HybridAIIcon() {
  return (
    <img
      src="/icons/hybridai.png"
      alt=""
      width="20"
      height="20"
      style={{ display: 'block', objectFit: 'contain' }}
    />
  );
}

function CodexIcon() {
  return (
    <img
      src="/icons/codex.svg"
      alt=""
      width="18"
      height="18"
      style={{ display: 'block', objectFit: 'contain' }}
    />
  );
}

function LocalIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect width="16" height="16" x="4" y="4" rx="2" />
      <rect width="6" height="6" x="9" y="9" />
      <path d="M15 2v2" />
      <path d="M15 20v2" />
      <path d="M2 15h2" />
      <path d="M2 9h2" />
      <path d="M20 15h2" />
      <path d="M20 9h2" />
      <path d="M9 2v2" />
      <path d="M9 20v2" />
    </svg>
  );
}

function ServerIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect width="20" height="8" x="2" y="2" rx="2" ry="2" />
      <rect width="20" height="8" x="2" y="14" rx="2" ry="2" />
      <line x1="6" x2="6.01" y1="6" y2="6" />
      <line x1="6" x2="6.01" y1="18" y2="18" />
    </svg>
  );
}

const PROVIDER_ICONS: Record<KnownProvider, () => ReactElement> = {
  HybridAI: HybridAIIcon,
  'OpenAI Codex': CodexIcon,
  Local: LocalIcon,
};

function ProviderIcon({ provider }: { provider: string }) {
  const Icon = PROVIDER_ICONS[provider as KnownProvider] ?? ServerIcon;
  return <Icon />;
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

function parseModel(entry: ModelSwitchEntry): ParsedModel {
  const id = entry.id;
  const parts = id.split('/');
  let provider: string;
  let vendor: string | null;
  let shortName: string;

  if (parts.length === 1) {
    provider = entry.backend ? pretty(entry.backend, {}) : 'Local';
    vendor = inferVendor(parts[0]);
    shortName = parts[0];
  } else if (parts.length === 2) {
    provider = pretty(parts[0], PROVIDER_LABELS);
    vendor = inferVendor(parts[1]);
    shortName = parts[1];
  } else {
    provider = pretty(parts[0], PROVIDER_LABELS);
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

  if (props.models.length === 0) return null;

  const selected = parsed.find((m) => m.id === props.selectedModelId);

  return (
    <Select
      value={selected ? props.selectedModelId : ''}
      disabled={props.disabled}
      onValueChange={(next) => {
        if (!next || next === props.selectedModelId) return;
        props.onSwitch(next);
      }}
    >
      <SelectTrigger aria-label="Switch model" title="Switch model">
        <SelectValue placeholder="Select model">
          {selected ? selected.displayName : ''}
        </SelectValue>
        <SelectIcon />
      </SelectTrigger>
      <SelectContent
        align="start"
        header={
          <SelectSearch
            value={query}
            onValueChange={setQuery}
            placeholder="Search models…"
            aria-label="Search models"
          />
        }
        rail={
          <SelectRail>
            <SelectRailItem
              label={railFilter === null ? 'All providers' : 'Clear filter'}
              active={railFilter === null}
              icon={<Menu width="16" height="16" />}
              onClick={() => setRailFilter(null)}
            />
            {railEntries.map(({ key, count }) => (
              <SelectRailItem
                key={key}
                label={`${key} (${count})`}
                active={railFilter === key}
                icon={<ProviderIcon provider={key} />}
                onClick={() =>
                  setRailFilter((prev) => (prev === key ? null : key))
                }
              />
            ))}
          </SelectRail>
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
                    <SelectItemBody>
                      <SelectItemText>{model.displayName}</SelectItemText>
                      {subtitle ? (
                        <SelectItemSubtitle>{subtitle}</SelectItemSubtitle>
                      ) : null}
                    </SelectItemBody>
                    <SelectItemMeta>
                      {model.meta.isReasoning ? (
                        <SelectBadge>Reasoning</SelectBadge>
                      ) : null}
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
