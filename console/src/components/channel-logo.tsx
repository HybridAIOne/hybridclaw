export function ChannelLogo(props: {
  kind:
    | 'discord'
    | 'telegram'
    | 'signal'
    | 'voice'
    | 'whatsapp'
    | 'email'
    | 'slack'
    | 'msteams'
    | 'imessage';
}) {
  switch (props.kind) {
    case 'discord':
      return (
        <span className="channel-logo" aria-hidden="true">
          <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
            <rect x="3" y="3" width="26" height="26" rx="9" fill="#5865F2" />
            <path
              fill="#FFFFFF"
              d="M10.6 21.7c1.5 1 3.3 1.7 5.1 1.9l.6-1.1c1 .2 2 .2 3 0l.6 1.1c1.9-.2 3.6-.9 5.1-1.9.3-3.2-.4-6.2-2-8.9a11.4 11.4 0 0 0-4.1-1.8l-.5 1a12.2 12.2 0 0 0-3.5 0l-.5-1a11.4 11.4 0 0 0-4.1 1.8c-1.6 2.7-2.3 5.7-2 8.9Z"
            />
            <circle cx="13.6" cy="16.9" r="1.25" fill="#5865F2" />
            <circle cx="18.4" cy="16.9" r="1.25" fill="#5865F2" />
          </svg>
        </span>
      );
    case 'whatsapp':
      return (
        <span className="channel-logo" aria-hidden="true">
          <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
            <circle cx="16" cy="16" r="13" fill="#25D366" />
            <path
              fill="#FFFFFF"
              d="M16 8.1a7.5 7.5 0 0 0-6.4 11.5l-.8 3 3.1-.8A7.5 7.5 0 1 0 16 8.1Zm0 13.3a5.8 5.8 0 0 1-3-.8l-.4-.2-1.8.5.5-1.7-.3-.4a5.8 5.8 0 1 1 5 2.6Z"
            />
            <path
              fill="#25D366"
              d="M13.2 12.3c-.2 0-.4.1-.5.4-.3.4-.7 1-.7 1.8s.7 1.7.8 1.8c.1.1 1.5 2.3 3.6 3.2 1.8.8 2.2.7 2.6.6.4-.1 1.2-.5 1.4-1 .1-.5.1-.8.1-.9 0-.1-.2-.2-.5-.3l-1.4-.7c-.2-.1-.4-.1-.5.1l-.6.8c-.1.1-.3.2-.5.1-.3-.1-1-.4-1.9-1.2-.8-.7-1.2-1.5-1.4-1.7-.1-.3 0-.4.1-.5l.4-.5c.1-.1.1-.3.2-.4s0-.3 0-.4l-.6-1.5c-.1-.3-.3-.4-.5-.4Z"
            />
          </svg>
        </span>
      );
    case 'telegram':
      return (
        <span className="channel-logo" aria-hidden="true">
          <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
            <circle cx="16" cy="16" r="13" fill="#27A7E7" />
            <path
              fill="#FFFFFF"
              d="m23.4 10.2-2.3 11c-.2 1-.8 1.3-1.6.8l-3.5-2.6-1.7 1.6c-.2.2-.4.4-.7.4l.3-3.7 6.8-6.1c.3-.3-.1-.4-.4-.2l-8.4 5.3-3.6-1.1c-.8-.2-.8-.8.2-1.2l14-5.4c.7-.3 1.2.2 1 .9Z"
            />
          </svg>
        </span>
      );
    case 'signal':
      return (
        <span className="channel-logo channel-logo-compact" aria-hidden="true">
          <svg viewBox="0 0 128 128" aria-hidden="true" focusable="false">
            <path
              fill="#3A76F0"
              d="M48.64,1.87l1.44,5.82A57.84,57.84,0,0,0,34,14.34L30.92,9.2A63.76,63.76,0,0,1,48.64,1.87Zm30.72,0L77.92,7.69A57.84,57.84,0,0,1,94,14.34l3.1-5.14A63.76,63.76,0,0,0,79.36,1.87ZM9.2,30.92A63.76,63.76,0,0,0,1.87,48.64l5.82,1.44A57.84,57.84,0,0,1,14.34,34ZM6,64a57.9,57.9,0,0,1,.65-8.69l-5.93-.9a64.23,64.23,0,0,0,0,19.18l5.93-.9A57.9,57.9,0,0,1,6,64Zm91.08,54.8L94,113.66a57.84,57.84,0,0,1-16.06,6.65l1.44,5.82A63.76,63.76,0,0,0,97.08,118.8ZM122,64a57.9,57.9,0,0,1-.65,8.69l5.93.9a64.23,64.23,0,0,0,0-19.18l-5.93.9A57.9,57.9,0,0,1,122,64Zm4.13,15.36-5.82-1.44A57.84,57.84,0,0,1,113.66,94l5.14,3.1A63.76,63.76,0,0,0,126.13,79.36Zm-53.44,42a58.41,58.41,0,0,1-17.38,0l-.9,5.93a64.23,64.23,0,0,0,19.18,0Zm38-22.95A58.21,58.21,0,0,1,98.4,110.69l3.56,4.83A64.1,64.1,0,0,0,115.52,102ZM98.4,17.31A58.21,58.21,0,0,1,110.69,29.6L115.52,26A64.1,64.1,0,0,0,102,12.48ZM17.31,29.6A58.21,58.21,0,0,1,29.6,17.31L26,12.48A64.1,64.1,0,0,0,12.48,26ZM118.8,30.92,113.66,34a57.84,57.84,0,0,1,6.65,16.06l5.82-1.44A63.76,63.76,0,0,0,118.8,30.92ZM55.31,6.65a58.41,58.41,0,0,1,17.38,0l.9-5.93a64.23,64.23,0,0,0-19.18,0ZM20.39,117.11,8,120l2.89-12.39-5.84-1.37L2.16,118.63a6,6,0,0,0,7.21,7.21L21.75,123ZM6.3,100.89l5.84,1.36,2-8.59A57.75,57.75,0,0,1,7.69,77.92L1.87,79.36a63.52,63.52,0,0,0,5.9,15.21Zm28,13-8.59,2,1.36,5.84,6.32-1.47a63.52,63.52,0,0,0,15.21,5.9l1.44-5.82A57.75,57.75,0,0,1,34.34,113.85ZM64,12A52,52,0,0,0,20,91.67L15,113l21.33-5A52,52,0,1,0,64,12Z"
            />
          </svg>
        </span>
      );
    case 'voice':
      return (
        <span className="channel-logo" aria-hidden="true">
          <svg
            viewBox="0 0 100 30"
            aria-hidden="true"
            focusable="false"
            fill="#F22F46"
          >
            <path d="M14.4 11.3c0 1.7-1.4 3.1-3.1 3.1S8.2 13 8.2 11.3s1.4-3.1 3.1-3.1 3.1 1.4 3.1 3.1zm-3.1 4.3c-1.7 0-3.1 1.4-3.1 3.1s1.4 3.1 3.1 3.1 3.1-1.4 3.1-3.1-1.4-3.1-3.1-3.1zM30 15c0 8.3-6.7 15-15 15S0 23.3 0 15 6.7 0 15 0s15 6.7 15 15zm-4 0c0-6.1-4.9-11-11-11S4 8.9 4 15s4.9 11 11 11 11-4.9 11-11zm-7.3.6c-1.7 0-3.1 1.4-3.1 3.1s1.4 3.1 3.1 3.1 3.1-1.4 3.1-3.1-1.4-3.1-3.1-3.1zm0-7.4c-1.7 0-3.1 1.4-3.1 3.1s1.4 3.1 3.1 3.1 3.1-1.4 3.1-3.1-1.4-3.1-3.1-3.1zm51.6-2.3c.1 0 .2.1.3.2v3.2c0 .2-.2.3-.3.3H65c-.2 0-.3-.2-.3-.3V6.2c0-.2.2-.3.3-.3h5.3zm-.1 4.5H60c-.1 0-.3.1-.3.3l-1.3 5-.1.3-1.6-5.3c0-.1-.2-.3-.3-.3h-4c-.1 0-.3.1-.3.3l-1.5 5-.1.3-.1-.3-.6-2.5-.6-2.5c0-.1-.2-.3-.3-.3h-8V6.1c0-.1-.2-.3-.4-.2l-5 1.6c-.2 0-.3.1-.3.3v2.7h-1.3c-.1 0-.3.1-.3.3v3.8c0 .1.1.3.3.3h1.3v4.7c0 3.3 1.8 4.8 5.1 4.8 1.4 0 2.7-.3 3.6-.8v-4c0-.2-.2-.3-.3-.2-.5.2-1 .3-1.4.3-.9 0-1.4-.4-1.4-1.4v-3.4h2.9c.1 0 .3-.1.3-.3v-3.2L47.8 24c0 .1.2.3.3.3h4.2c.1 0 .3-.1.3-.3l1.8-5.6.9 2.9.8 2.7c0 .1.2.3.3.3h4.2c.1 0 .3-.1.3-.3l3.8-12.6V24c0 .1.1.3.3.3h5.1c.1 0 .3-.1.3-.3V10.7c0-.1-.1-.3-.2-.3zm6.7-4.5h-5.1c-.1 0-.3.1-.3.3v17.7c0 .1.1.3.3.3h5.1c.1 0 .3-.1.3-.3V6.1c0-.1-.1-.2-.3-.2zm6.8 0h-5.3c-.1 0-.3.1-.3.3v3.1c0 .1.1.3.3.3h5.3c.1 0 .3-.1.3-.3V6.1c0-.1-.1-.2-.3-.2zm-.1 4.5h-5.1c-.1 0-.3.1-.3.3v13.1c0 .1.1.3.3.3h5.1c.1 0 .3-.1.3-.3V10.7c0-.1-.1-.3-.3-.3zm16.1 6.8c0 3.8-3.2 7.1-7.7 7.1-4.4 0-7.6-3.3-7.6-7.1s3.2-7.1 7.7-7.1c4.4 0 7.6 3.3 7.6 7.1zm-5.4.1c0-1.4-1-2.5-2.2-2.4-1.3 0-2.2 1.1-2.2 2.4s1 2.4 2.2 2.4c1.3 0 2.2-1.1 2.2-2.4z" />
          </svg>
        </span>
      );
    case 'email':
      return (
        <span className="channel-logo" aria-hidden="true">
          <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
            <rect x="3" y="5" width="26" height="22" rx="6" fill="#2563EB" />
            <path fill="#FFFFFF" d="M8 10.5h16v11H8z" />
            <path
              d="m8.8 11.6 7.2 5.2 7.2-5.2"
              fill="none"
              stroke="#2563EB"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="m8.8 20.8 5.5-4.6m8.9 4.6-5.5-4.6"
              fill="none"
              stroke="#93C5FD"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </span>
      );
    case 'slack':
      return (
        <span className="channel-logo channel-logo-compact" aria-hidden="true">
          <svg viewBox="0 0 127 127" aria-hidden="true" focusable="false">
            <path
              fill="#E01E5A"
              d="M27.2 80c0 7.3-5.9 13.2-13.2 13.2C6.7 93.2.8 87.3.8 80c0-7.3 5.9-13.2 13.2-13.2h13.2V80zm6.6 0c0-7.3 5.9-13.2 13.2-13.2 7.3 0 13.2 5.9 13.2 13.2v33c0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V80z"
            />
            <path
              fill="#36C5F0"
              d="M47 27c-7.3 0-13.2-5.9-13.2-13.2C33.8 6.5 39.7.6 47 .6c7.3 0 13.2 5.9 13.2 13.2V27H47zm0 6.7c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H13.9C6.6 60.1.7 54.2.7 46.9c0-7.3 5.9-13.2 13.2-13.2H47z"
            />
            <path
              fill="#2EB67D"
              d="M99.9 46.9c0-7.3 5.9-13.2 13.2-13.2 7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H99.9V46.9zm-6.6 0c0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V13.8C66.9 6.5 72.8.6 80.1.6c7.3 0 13.2 5.9 13.2 13.2v33.1z"
            />
            <path
              fill="#ECB22E"
              d="M80.1 99.8c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V99.8h13.2zm0-6.6c-7.3 0-13.2-5.9-13.2-13.2 0-7.3 5.9-13.2 13.2-13.2h33.1c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H80.1z"
            />
          </svg>
        </span>
      );
    case 'msteams':
      return (
        <span className="channel-logo" aria-hidden="true">
          <svg
            viewBox="4 4 36 38"
            aria-hidden="true"
            focusable="false"
            fill="none"
          >
            <path
              fill="url(#teams-logo-a)"
              d="M21.9999 20h12c3.3137 0 6 2.6863 6 6v10c0 3.3137-2.6863 6-6 6s-6-2.6863-6-6V26c0-3.3137-2.6863-6-6-6"
            />
            <path
              fill="url(#teams-logo-b)"
              d="M7.99988 24c0-3.3137 2.68632-6 6.00002-6h8c3.3137 0 6 2.6863 6 6v12c0 3.3137 2.6863 6 6 6l-16.0001-.0001c-5.5228 0-9.99992-4.4771-9.99992-10z"
            />
            <path
              fill="url(#teams-logo-c)"
              fillOpacity=".7"
              d="M7.99988 24c0-3.3137 2.68632-6 6.00002-6h8c3.3137 0 6 2.6863 6 6v12c0 3.3137 2.6863 6 6 6l-16.0001-.0001c-5.5228 0-9.99992-4.4771-9.99992-10z"
            />
            <path
              fill="url(#teams-logo-d)"
              fillOpacity=".7"
              d="M7.99988 24c0-3.3137 2.68632-6 6.00002-6h8c3.3137 0 6 2.6863 6 6v12c0 3.3137 2.6863 6 6 6l-16.0001-.0001c-5.5228 0-9.99992-4.4771-9.99992-10z"
            />
            <path
              fill="url(#teams-logo-e)"
              d="M32.9999 18c2.7614 0 5-2.2386 5-5s-2.2386-5-5-5-5 2.2386-5 5 2.2386 5 5 5"
            />
            <path
              fill="url(#teams-logo-f)"
              fillOpacity=".46"
              d="M32.9999 18c2.7614 0 5-2.2386 5-5s-2.2386-5-5-5-5 2.2386-5 5 2.2386 5 5 5"
            />
            <path
              fill="url(#teams-logo-g)"
              fillOpacity=".4"
              d="M32.9999 18c2.7614 0 5-2.2386 5-5s-2.2386-5-5-5-5 2.2386-5 5 2.2386 5 5 5"
            />
            <path
              fill="url(#teams-logo-h)"
              d="M17.9999 16c3.3137 0 6-2.6863 6-6 0-3.31371-2.6863-6-6-6s-6 2.68629-6 6c0 3.3137 2.6863 6 6 6"
            />
            <path
              fill="url(#teams-logo-i)"
              fillOpacity=".6"
              d="M17.9999 16c3.3137 0 6-2.6863 6-6 0-3.31371-2.6863-6-6-6s-6 2.68629-6 6c0 3.3137 2.6863 6 6 6"
            />
            <path
              fill="url(#teams-logo-j)"
              fillOpacity=".5"
              d="M17.9999 16c3.3137 0 6-2.6863 6-6 0-3.31371-2.6863-6-6-6s-6 2.68629-6 6c0 3.3137 2.6863 6 6 6"
            />
            <rect
              width="16"
              height="16"
              x="4"
              y="23"
              fill="url(#teams-logo-k)"
              rx="3.25"
            />
            <rect
              width="16"
              height="16"
              x="4"
              y="23"
              fill="url(#teams-logo-l)"
              fillOpacity=".7"
              rx="3.25"
            />
            <path
              fill="#fff"
              d="M15.4792 28.1054h-2.4471v7.466h-2.0648v-7.466H8.52014v-1.6768h6.95906z"
            />
            <defs>
              <radialGradient
                id="teams-logo-a"
                cx="0"
                cy="0"
                r="1"
                gradientTransform="matrix(13.4784 0 0 33.2694 39.7967 22.1739)"
                gradientUnits="userSpaceOnUse"
              >
                <stop stopColor="#a98aff" />
                <stop offset=".14" stopColor="#8c75ff" />
                <stop offset=".565" stopColor="#5f50e2" />
                <stop offset=".9" stopColor="#3c2cb8" />
              </radialGradient>
              <radialGradient
                id="teams-logo-b"
                cx="0"
                cy="0"
                r="1"
                gradientTransform="rotate(68.1539 -7.71566095 14.71355834)scale(32.752 33.1231)"
                gradientUnits="userSpaceOnUse"
              >
                <stop stopColor="#85c2ff" />
                <stop offset=".69" stopColor="#7588ff" />
                <stop offset="1" stopColor="#6459fe" />
              </radialGradient>
              <linearGradient
                id="teams-logo-c"
                x1="20.5936"
                x2="20.5936"
                y1="18"
                y2="42"
                gradientUnits="userSpaceOnUse"
              >
                <stop offset=".801159" stopColor="#6864f6" stopOpacity="0" />
                <stop offset="1" stopColor="#5149de" />
              </linearGradient>
              <radialGradient
                id="teams-logo-d"
                cx="0"
                cy="0"
                r="1"
                gradientTransform="rotate(113.326 8.09285255 17.64474501)scale(19.2186 15.4273)"
                gradientUnits="userSpaceOnUse"
              >
                <stop stopColor="#bd96ff" />
                <stop offset=".686685" stopColor="#bd96ff" stopOpacity="0" />
              </radialGradient>
              <radialGradient
                id="teams-logo-e"
                cx="0"
                cy="0"
                r="1"
                gradientTransform="matrix(0 -10 12.6216 0 32.9999 11.5714)"
                gradientUnits="userSpaceOnUse"
              >
                <stop offset=".268201" stopColor="#6868f7" />
                <stop offset="1" stopColor="#3923b1" />
              </radialGradient>
              <radialGradient
                id="teams-logo-f"
                cx="0"
                cy="0"
                r="1"
                gradientTransform="rotate(40.0516 -.03068196 44.8729095)scale(7.14629 10.3363)"
                gradientUnits="userSpaceOnUse"
              >
                <stop offset=".270711" stopColor="#a1d3ff" />
                <stop offset=".813393" stopColor="#a1d3ff" stopOpacity="0" />
              </radialGradient>
              <radialGradient
                id="teams-logo-g"
                cx="0"
                cy="0"
                r="1"
                gradientTransform="rotate(-41.6581 32.11799918 -43.41948423)scale(8.51275 20.8824)"
                gradientUnits="userSpaceOnUse"
              >
                <stop stopColor="#e3acfd" />
                <stop offset=".816041" stopColor="#9fa2ff" stopOpacity="0" />
              </radialGradient>
              <radialGradient
                id="teams-logo-h"
                cx="0"
                cy="0"
                r="1"
                gradientTransform="matrix(0 -12 15.146 0 17.9999 8.28571)"
                gradientUnits="userSpaceOnUse"
              >
                <stop offset=".268201" stopColor="#8282ff" />
                <stop offset="1" stopColor="#3923b1" />
              </radialGradient>
              <radialGradient
                id="teams-logo-i"
                cx="0"
                cy="0"
                r="1"
                gradientTransform="rotate(40.0516 -3.15465147 21.41641466)scale(8.57554 12.4035)"
                gradientUnits="userSpaceOnUse"
              >
                <stop offset=".270711" stopColor="#a1d3ff" />
                <stop offset=".813393" stopColor="#a1d3ff" stopOpacity="0" />
              </radialGradient>
              <radialGradient
                id="teams-logo-j"
                cx="0"
                cy="0"
                r="1"
                gradientTransform="rotate(-41.6581 20.38180375 -26.51566158)scale(10.2153 25.0589)"
                gradientUnits="userSpaceOnUse"
              >
                <stop stopColor="#e3acfd" />
                <stop offset=".816041" stopColor="#9fa2ff" stopOpacity="0" />
              </radialGradient>
              <radialGradient
                id="teams-logo-k"
                cx="0"
                cy="0"
                r="1"
                gradientTransform="rotate(45 -25.76345597 16.32842712)scale(22.6274)"
                gradientUnits="userSpaceOnUse"
              >
                <stop offset=".046875" stopColor="#688eff" />
                <stop offset=".946875" stopColor="#230f94" />
              </radialGradient>
              <radialGradient
                id="teams-logo-l"
                cx="0"
                cy="0"
                r="1"
                gradientTransform="matrix(0 11.2 -13.0702 0 12 32.6)"
                gradientUnits="userSpaceOnUse"
              >
                <stop offset=".570647" stopColor="#6965f6" stopOpacity="0" />
                <stop offset="1" stopColor="#8f8fff" />
              </radialGradient>
            </defs>
          </svg>
        </span>
      );
    case 'imessage':
      return (
        <span className="channel-logo" aria-hidden="true">
          <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
            <path
              fill="#34C759"
              d="M16 4.5c6.4 0 11.5 4.2 11.5 9.5 0 5.2-5.1 9.5-11.5 9.5-1 0-2-.1-2.9-.3L7.4 27l1.8-4.2C6.3 21 4.5 17.8 4.5 14c0-5.3 5.1-9.5 11.5-9.5Z"
            />
            <path
              fill="#FFFFFF"
              d="M10.7 12.2h10.6c.6 0 1 .4 1 1s-.4 1-1 1H10.7c-.6 0-1-.4-1-1s.4-1 1-1Zm0 4.6h7.8c.6 0 1 .4 1 1s-.4 1-1 1h-7.8c-.6 0-1-.4-1-1s.4-1 1-1Z"
            />
          </svg>
        </span>
      );
  }
}
