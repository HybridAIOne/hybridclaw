import type { ReactNode, SVGProps } from 'react';

export type ProviderLogoProps = SVGProps<SVGSVGElement>;

function Frame({
  children,
  viewBox = '0 0 24 24',
  ...rest
}: ProviderLogoProps & { children: ReactNode }) {
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
        <linearGradient
          id="gemini-grad"
          x1="0"
          y1="0"
          x2="24"
          y2="24"
          gradientUnits="userSpaceOnUse"
        >
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
      <path
        fill="#000"
        d="M186 28h42v42h-42zM28 28h42v42H28zM28 70h42v42H28zM28 112h42v42H28zM28 154h42v42H28zM28 196h42v42H28z"
      />
      <path fill="#F7D046" d="M186 28h42v42h-42z" />
      <path fill="#F2A73B" d="M70 70h42v42H70zM186 70h42v42h-42z" />
      <path
        fill="#EE792F"
        d="M112 112h42v42h-42zM70 112h42v42H70zM186 112h42v42h-42z"
      />
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
    <Frame viewBox="0 0 466.04 516.93" {...props}>
      <path
        fill="currentColor"
        d="M.12 182.71h104.01l234.02 334.21H234.14L.12 182.71Z"
      />
      <path
        fill="currentColor"
        d="M0 516.92h104.08l52-74.25-52.04-74.33L0 516.92Z"
      />
      <path
        fill="currentColor"
        d="M466.04 0H361.96L182.1 256.86l52.05 74.32L466.04 0Z"
      />
      <path
        fill="currentColor"
        d="M380.78 516.92h85.26V37.16L380.78 158.92v358Z"
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
    <Frame viewBox="0 0 64 64" {...props}>
      <image
        href="/icons/hybridai.png"
        width="64"
        height="64"
        preserveAspectRatio="xMidYMid meet"
      />
    </Frame>
  );
}

export function OllamaLogo(props: ProviderLogoProps) {
  return (
    <Frame viewBox="0 0 17 25" {...props}>
      <path
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M4.405.102c.216.097.411.256.588.466.295.348.544.845.734 1.435.191.593.315 1.25.362 1.909a4.311 4.311 0 0 1 2.049-.723l.051-.004c.87-.08 1.73.099 2.48.539.101.06.2.125.297.193.05-.647.172-1.289.36-1.868.19-.591.439-1.088.733-1.437.164-.202.365-.361.589-.466.257-.113.53-.134.796-.047.401.129.745.418 1.016.837.248.383.434.874.561 1.463.23 1.061.27 2.458.115 4.142l.053.045.026.022c.757.654 1.284 1.587 1.563 2.67.435 1.69.216 3.585-.534 4.646l-.018.023.002.004c.417.865.67 1.78.724 2.726l.002.034c.064 1.21-.2 2.428-.814 3.625l-.007.011.01.028c.472 1.314.62 2.638.438 3.961l-.006.044a.705.705 0 0 1-.263.48.61.61 0 0 1-.484.129.647.647 0 0 1-.424-.294.816.816 0 0 1-.116-.549c.167-1.174.01-2.351-.48-3.549a.79.79 0 0 1 .04-.708l.004-.007c.604-1.05.854-2.079.8-3.091-.046-.885-.325-1.754-.8-2.583a.797.797 0 0 1-.091-.545.75.75 0 0 1 .272-.462l.009-.007c.243-.181.467-.642.58-1.273.125-.745.092-1.514-.095-2.243-.205-.795-.58-1.459-1.105-1.912-.595-.516-1.383-.765-2.38-.693a.605.605 0 0 1-.632-.422c-.314-.756-.772-1.297-1.343-1.632a3.184 3.184 0 0 0-1.772-.377c-1.245.113-2.343.91-2.67 1.916a.695.695 0 0 1-.61.483c-1.067.002-1.893.286-2.497.799-.522.443-.878 1.062-1.066 1.804a5.095 5.095 0 0 0-.068 2.143c.112.634.331 1.159.582 1.442l.008.008a.797.797 0 0 1 .109.892c-.36.707-.629 1.76-.673 2.773-.05 1.157.186 2.161.719 2.882l.016.021a.793.793 0 0 1 .095.784c-.576 1.405-.753 2.559-.562 3.468a.763.763 0 0 1-.49.871.616.616 0 0 1-.485-.086.724.724 0 0 1-.295-.446c-.243-1.157-.078-2.482.473-3.975l.014-.04-.008-.013a5.125 5.125 0 0 1-.598-1.488l-.005-.022a6.376 6.376 0 0 1-.177-2.028c.044-1.034.278-2.093.622-2.943l.012-.03-.002-.002c-.293-.475-.51-1.083-.63-1.756l-.005-.027a6.282 6.282 0 0 1 .093-2.829c.262-1.04.777-1.933 1.536-2.578.06-.051.123-.102.186-.15-.159-1.697-.119-3.102.112-4.171.127-.588.314-1.079.562-1.462.27-.418.614-.707 1.015-.838.266-.086.54-.066.797.049Zm4.116 10.329c.936 0 1.8.356 2.446.972.63.599 1.005 1.403 1.005 2.205 0 1.008-.406 1.795-1.133 2.297-.62.426-1.451.633-2.403.633-1.009 0-1.871-.294-2.493-.834-.617-.534-.963-1.284-.963-2.096 0-.804.398-1.61 1.056-2.212.668-.61 1.55-.965 2.485-.965Zm0 1.019a2.88 2.88 0 0 0-1.916.738c-.461.421-.722.949-.722 1.421 0 .486.21.942.61 1.288.455.395 1.124.623 1.943.623.799 0 1.473-.167 1.932-.484.463-.318.7-.78.7-1.428 0-.481-.246-1.012-.683-1.427a2.722 2.722 0 0 0-1.864-.731Zm.662 1.375.004.004a.409.409 0 0 1-.056.557l-.292.261v.507a.39.39 0 0 1-.376.424.39.39 0 0 1-.376-.424v-.523l-.271-.247a.407.407 0 0 1-.052-.557.356.356 0 0 1 .494-.058l.211.195.22-.197a.355.355 0 0 1 .49.058Zm-5.04-2.181c.478 0 .867.443.867.99a.93.93 0 0 1-.868.989.93.93 0 0 1-.867-.988.93.93 0 0 1 .868-.991Zm8.706 0c.48 0 .868.443.868.99a.93.93 0 0 1-.868.989.93.93 0 0 1-.867-.988.93.93 0 0 1 .867-.991ZM3.94 1.477l-.003.002a.685.685 0 0 0-.285.271l-.005.007c-.138.214-.258.53-.348.945-.17.786-.216 1.853-.124 3.161.43-.145.899-.236 1.404-.269l.01-.001.019-.039c.046-.093.095-.183.148-.271.123-.876.022-1.923-.253-2.778-.134-.413-.297-.738-.453-.923a.583.583 0 0 0-.107-.102l-.003-.003Zm9.174.045-.002.002a.577.577 0 0 0-.107.102c-.156.185-.32.511-.453.925-.29.902-.387 2.018-.23 2.922l.058.111.008.016h.03c.497 0 .99.081 1.466.241.086-1.278.038-2.322-.128-3.094-.09-.414-.21-.73-.349-.945l-.004-.007a.69.69 0 0 0-.285-.271l-.004-.002Z"
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
  return (
    <Frame viewBox="0 0 96 96" {...props}>
      <path
        fill="currentColor"
        opacity="0.28"
        d="M42.22 28.47v55.31L14.57 28.47Z"
      />
      <path
        fill="currentColor"
        opacity="0.28"
        d="M42.22 83.78h21.73L82.61 13.39 57.03 26.85Z"
      />
      <path fill="currentColor" d="M41.05 27.29v55.31L13.39 27.29Z" />
      <path
        fill="currentColor"
        d="M41.05 82.6h21.73l18.65-70.38-25.57 13.46Z"
      />
    </Frame>
  );
}

export function AlibabaLogo(props: ProviderLogoProps) {
  return <Badge letter="Q" fill="#FF6A00" {...props} />;
}
