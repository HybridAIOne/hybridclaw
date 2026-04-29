import type { SVGProps } from 'react';

export type ProviderLogoProps = SVGProps<SVGSVGElement>;

function Frame({
  children,
  viewBox = '0 0 24 24',
  ...rest
}: ProviderLogoProps & { children: React.ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="18"
      height="18"
      viewBox={viewBox}
      xmlns="http://www.w3.org/2000/svg"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function AnthropicLogo(props: ProviderLogoProps) {
  return (
    <Frame viewBox="0 0 24 24" {...props}>
      <path
        fill="#D97757"
        d="M13.83 4h-3.43l5.93 16h3.43L13.83 4ZM6.78 4 .85 20h3.5l1.21-3.4h6.16L12.93 20h3.5L10.5 4H6.78Zm-.06 9.46 2.06-5.78 2.06 5.78H6.72Z"
      />
    </Frame>
  );
}

export function OpenAILogo(props: ProviderLogoProps) {
  return (
    <Frame viewBox="0 0 24 24" {...props}>
      <path
        fill="currentColor"
        d="M22.28 9.82a5.95 5.95 0 0 0-.51-4.92 6.06 6.06 0 0 0-6.51-2.91A6.07 6.07 0 0 0 4.98 4.18a5.95 5.95 0 0 0-3.97 2.88 6.04 6.04 0 0 0 .74 7.08 5.95 5.95 0 0 0 .51 4.91 6.06 6.06 0 0 0 6.5 2.92 5.95 5.95 0 0 0 4.49 2.01 6.06 6.06 0 0 0 5.78-4.21 5.96 5.96 0 0 0 3.97-2.89 6.06 6.06 0 0 0-.75-7.06ZM13.26 20.6a4.5 4.5 0 0 1-2.88-1.04l.14-.08 4.78-2.76a.78.78 0 0 0 .39-.68v-6.74l2.02 1.17.02.04v5.58a4.5 4.5 0 0 1-4.47 4.51ZM3.6 16.48a4.5 4.5 0 0 1-.54-3.03l.14.09 4.78 2.76a.78.78 0 0 0 .79 0l5.83-3.36v2.33a.07.07 0 0 1-.03.06L9.74 18.13a4.5 4.5 0 0 1-6.14-1.65Zm-1.26-10.4a4.5 4.5 0 0 1 2.34-1.97v5.68a.78.78 0 0 0 .39.68l5.81 3.35-2.02 1.17a.07.07 0 0 1-.07 0L4.06 12.2a4.5 4.5 0 0 1-1.72-6.14ZM18.85 9.5l-5.81-3.4 2.02-1.16a.07.07 0 0 1 .07 0l4.83 2.79a4.5 4.5 0 0 1-.68 8.13v-5.68a.79.79 0 0 0-.43-.68Zm2.01-3.02-.14-.09-4.77-2.78a.78.78 0 0 0-.78 0L9.34 6.97V4.64a.07.07 0 0 1 .03-.06l4.83-2.78a4.5 4.5 0 0 1 6.66 4.67ZM8.24 10.62 6.22 9.45a.07.07 0 0 1-.03-.05V3.83a4.5 4.5 0 0 1 7.38-3.46l-.14.08-4.78 2.76a.78.78 0 0 0-.39.68l-.02 6.73Zm1.1-2.36 2.6-1.5 2.6 1.5v3l-2.6 1.5-2.6-1.5v-3Z"
      />
    </Frame>
  );
}

export function GeminiLogo(props: ProviderLogoProps) {
  return (
    <Frame viewBox="0 0 24 24" {...props}>
      <defs>
        <linearGradient id="gemini-grad" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#1C7DFF" />
          <stop offset="0.52" stopColor="#1C69FF" />
          <stop offset="1" stopColor="#F0DCD6" />
        </linearGradient>
      </defs>
      <path
        fill="url(#gemini-grad)"
        d="M12 24a14.34 14.34 0 0 0-2.26-3.78A14.27 14.27 0 0 0 5.95 17 14.34 14.34 0 0 0 0 12a14.27 14.27 0 0 0 5.95-3.18A14.27 14.27 0 0 0 9.74 5 14.34 14.34 0 0 0 12 0a14.34 14.34 0 0 0 2.26 3.78A14.27 14.27 0 0 0 18.05 7 14.27 14.27 0 0 0 24 12a14.34 14.34 0 0 0-5.95 3.18A14.27 14.27 0 0 0 14.26 19 14.34 14.34 0 0 0 12 24Z"
      />
    </Frame>
  );
}

export function DeepSeekLogo(props: ProviderLogoProps) {
  return (
    <Frame viewBox="0 0 24 24" {...props}>
      <path
        fill="#4D6BFE"
        d="M22.92 5.5a.5.5 0 0 0-.78-.42l-.95.65a.6.6 0 0 1-.69-.02 8.93 8.93 0 0 0-3.16-1.43c-.35-.08-.46-.5-.2-.74.27-.25.13-.7-.23-.76a8.94 8.94 0 0 0-3.4-.04 8.84 8.84 0 0 0-7.13 7.4 8.7 8.7 0 0 0 .15 3.59c.21.86.55 1.66.99 2.4a.6.6 0 0 1-.06.7l-.85.94a.5.5 0 0 0 .35.83l1.39.06a.6.6 0 0 1 .56.5 8.84 8.84 0 0 0 8.74 7.34 8.84 8.84 0 0 0 5.93-2.27.5.5 0 0 0-.34-.86l-1.18-.05a.6.6 0 0 1-.55-.5 8.84 8.84 0 0 0-3.59-5.65.6.6 0 0 1-.13-.85 8.84 8.84 0 0 0 1.85-4.7.6.6 0 0 1 .39-.5l1.74-.62a.5.5 0 0 0 .31-.62l-.06-.18ZM14.6 9a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z"
      />
    </Frame>
  );
}

export function MistralLogo(props: ProviderLogoProps) {
  return (
    <Frame viewBox="0 0 256 256" {...props}>
      <path fill="#000" d="M186 28h42v42h-42zM28 28h42v42H28zM28 70h42v42H28zM28 112h42v42H28zM28 154h42v42H28zM28 196h42v42H28z" />
      <path fill="#F7D046" d="M186 28h42v42h-42z" />
      <path fill="#F2A73B" d="M70 70h42v42H70zM186 70h42v42h-42z" />
      <path fill="#EE792F" d="M112 112h42v42h-42zM70 112h42v42H70zM186 112h42v42h-42z" />
      <path fill="#EB5829" d="M70 154h42v42H70zM186 154h42v42h-42z" />
      <path fill="#EA3326" d="M70 196h42v42H70zM186 196h42v42h-42z" />
    </Frame>
  );
}

export function MetaLogo(props: ProviderLogoProps) {
  return (
    <Frame viewBox="0 0 24 24" {...props}>
      <path
        fill="#0866FF"
        d="M5.31 8.78c.85-1.32 1.99-2.32 3.27-2.32 1.46 0 2.45.69 4.32 3.41 2 2.92 2.46 3.6 3.46 3.6.96 0 1.62-.91 1.62-2.55 0-1.83-.89-3.31-2.36-3.31-.79 0-1.6.31-2.45 1.18l-1.18-1.6C12.97 6.18 14.31 5 16.32 5c2.96 0 4.68 2.75 4.68 5.65 0 3.16-1.81 4.91-4.18 4.91-1.79 0-2.95-.71-4.4-2.83l-1.93-2.86c-.71-1.07-1.16-1.43-1.86-1.43-.94 0-1.61 1.03-1.61 2.5 0 1.49.5 2.36 1.55 2.36.61 0 1.13-.16 1.69-.6l.99 1.69c-.96.74-2 1.18-3.08 1.18C5.42 15.57 3 13.78 3 10.27 3 7.18 4.84 5 7.27 5c1.48 0 2.6.69 3.4 1.95l-1.36 1.83c-.66-.85-1.34-1.27-2.1-1.27-1.16 0-2.06 1.16-2.06 2.84 0 1.62.78 2.61 1.84 2.61.62 0 1.06-.21 1.41-.49Z"
      />
    </Frame>
  );
}

export function XaiLogo(props: ProviderLogoProps) {
  return (
    <Frame viewBox="0 0 24 24" {...props}>
      <path
        fill="currentColor"
        d="M3.5 3h3.7l4.4 6.1L16.6 3h3.9l-6.7 8.7L21 21h-3.7l-5-6.9L7.4 21H3.5l6.9-9.2L3.5 3Z"
      />
    </Frame>
  );
}

export function HuggingFaceLogo(props: ProviderLogoProps) {
  return (
    <Frame viewBox="0 0 24 24" {...props}>
      <circle cx="12" cy="12" r="10" fill="#FFD21E" />
      <circle cx="8.5" cy="10.5" r="1.4" fill="#3A3B45" />
      <circle cx="15.5" cy="10.5" r="1.4" fill="#3A3B45" />
      <path
        fill="#3A3B45"
        d="M8 14.5a4 4 0 0 0 8 0c0-.6-.5-1-1.1-1H9.1c-.6 0-1.1.4-1.1 1Z"
      />
    </Frame>
  );
}

export function OpenRouterLogo(props: ProviderLogoProps) {
  return (
    <Frame viewBox="0 0 24 24" {...props}>
      <path
        fill="currentColor"
        d="M3 7.5a1.5 1.5 0 0 1 1.5-1.5h3.6a4.5 4.5 0 0 1 3.18 1.32L13.06 9h6.94a1.5 1.5 0 0 1 0 3h-7.56a1.5 1.5 0 0 1-1.06-.44L9.6 9.72A1.5 1.5 0 0 0 8.54 9.3H4.5A1.5 1.5 0 0 1 3 7.8v-.3Zm0 9a1.5 1.5 0 0 1 1.5-1.5h3.6a4.5 4.5 0 0 1 3.18 1.32L13.06 18h6.94a1.5 1.5 0 0 1 0-3h-3.34l-1.62-1.62a4.5 4.5 0 0 0-3.18-1.32H4.5A1.5 1.5 0 0 1 3 16.5Z"
      />
    </Frame>
  );
}

export function MicrosoftLogo(props: ProviderLogoProps) {
  return (
    <Frame viewBox="0 0 24 24" {...props}>
      <rect x="2" y="2" width="9.5" height="9.5" fill="#F25022" />
      <rect x="12.5" y="2" width="9.5" height="9.5" fill="#7FBA00" />
      <rect x="2" y="12.5" width="9.5" height="9.5" fill="#00A4EF" />
      <rect x="12.5" y="12.5" width="9.5" height="9.5" fill="#FFB900" />
    </Frame>
  );
}

export function HybridAILogo(props: ProviderLogoProps) {
  return (
    <Frame viewBox="0 0 24 24" {...props}>
      <path
        fill="currentColor"
        d="M5 4h2v7h10V4h2v16h-2v-7H7v7H5V4Z"
      />
    </Frame>
  );
}

export function OllamaLogo(props: ProviderLogoProps) {
  return (
    <Frame viewBox="0 0 24 24" {...props}>
      <path
        fill="currentColor"
        d="M5 13.5c0-3 1-6.5 4-7.5.5 0 .8.5.6 1l-.4 1c-.1.4-.5.7-.9.7-1.5 0-2.3 1.7-2.3 3.8v.5c0 .3.3.5.6.5h.4c.4 0 .7.3.7.7v.6c0 .4-.3.7-.7.7H7c-1.1 0-2 .9-2 2v.5c0 .4-.3.7-.7.7H4a1 1 0 0 1-1-1v-.6c0-1.6.8-3.1 2-4Zm14 0c0-3-1-6.5-4-7.5-.5 0-.8.5-.6 1l.4 1c.1.4.5.7.9.7 1.5 0 2.3 1.7 2.3 3.8v.5c0 .3-.3.5-.6.5h-.4c-.4 0-.7.3-.7.7v.6c0 .4.3.7.7.7h.6c1.1 0 2 .9 2 2v.5c0 .4.3.7.7.7H20a1 1 0 0 0 1-1v-.6c0-1.6-.8-3.1-2-4Zm-7-7.5a4 4 0 0 0-4 4v6c0 1.1.9 2 2 2h4c1.1 0 2-.9 2-2v-6a4 4 0 0 0-4-4Zm-1.5 4.5a.7.7 0 1 1 0 1.4.7.7 0 0 1 0-1.4Zm3 0a.7.7 0 1 1 0 1.4.7.7 0 0 1 0-1.4Z"
      />
    </Frame>
  );
}

interface BadgeProps extends ProviderLogoProps {
  letter: string;
  fill?: string;
  color?: string;
}

function Badge({
  letter,
  fill = 'currentColor',
  color = '#fff',
  ...rest
}: BadgeProps) {
  return (
    <Frame viewBox="0 0 24 24" {...rest}>
      <rect width="24" height="24" rx="6" fill={fill} />
      <text
        x="12"
        y="16.5"
        textAnchor="middle"
        fontFamily="system-ui, -apple-system, sans-serif"
        fontSize="13"
        fontWeight="700"
        fill={color}
      >
        {letter}
      </text>
    </Frame>
  );
}

export function CodexLogo(props: ProviderLogoProps) {
  return <OpenAILogo {...props} />;
}

export function ZaiLogo(props: ProviderLogoProps) {
  return <Badge letter="Z" fill="#1F6FEB" {...props} />;
}

export function KimiLogo(props: ProviderLogoProps) {
  return <Badge letter="K" fill="#0F172A" {...props} />;
}

export function MiniMaxLogo(props: ProviderLogoProps) {
  return <Badge letter="M" fill="#7C3AED" {...props} />;
}

export function DashScopeLogo(props: ProviderLogoProps) {
  return <Badge letter="Q" fill="#FF6A00" {...props} />;
}

export function XiaomiLogo(props: ProviderLogoProps) {
  return <Badge letter="Mi" fill="#FF6900" {...props} />;
}

export function KiloLogo(props: ProviderLogoProps) {
  return <Badge letter="K" fill="#10B981" {...props} />;
}

export function LMStudioLogo(props: ProviderLogoProps) {
  return <Badge letter="LM" fill="#0EA5E9" {...props} />;
}

export function LlamaCppLogo(props: ProviderLogoProps) {
  return <Badge letter="L" fill="#475569" {...props} />;
}

export function VLLMLogo(props: ProviderLogoProps) {
  return <Badge letter="v" fill="#0F766E" {...props} />;
}

export function AlibabaLogo(props: ProviderLogoProps) {
  return <Badge letter="Q" fill="#FF6A00" {...props} />;
}
