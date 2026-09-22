/**
 * Privacy-level pictograms distinguish endpoint ownership from hosting location.
 * These decorative marks share one geometry; they never determine routing policy.
 */
import { HybridAILogo } from './HybridAILogo';

export function PrivacyLevelIcon({ zone }: { zone: string }) {
  if (zone === 'hai') return <HybridAILogo width={28} height={28} />;
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {zone === 'local' ? (
        <>
          <rect x="6" y="5" width="20" height="16" rx="2" />
          <path d="M3 26h26l-3-5H6l-3 5Z" />
          <path d="M13 24h6" />
        </>
      ) : zone === 'eu-provider' ? (
        <>
          <path d="M16 3 27 7v8c0 7-6 11-11 14C11 26 5 22 5 15V7L16 3Z" />
          <path d="M10 22h12M11 21v-9h10v9m-7 0v-4h4v4M14 9h4" />
          <path d="M14 14h.1m3.8 0h.1" />
        </>
      ) : zone === 'region' ? (
        <>
          <path d="M25 13c0 7-9 16-9 16S7 20 7 13a9 9 0 1 1 18 0Z" />
          <rect x="11" y="8" width="10" height="10" rx="2" />
          <path d="M11 13h10m-7-2.5h.1m-.1 5h.1" />
        </>
      ) : (
        <>
          <circle cx="16" cy="16" r="12" />
          <ellipse cx="16" cy="16" rx="5" ry="12" />
          <path d="M4 16h24M7 9h18M7 23h18" />
        </>
      )}
    </svg>
  );
}
