export function ChannelLogo(props: {
  kind:
    | 'discord'
    | 'telegram'
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
        <span className="channel-logo" aria-hidden="true">
          <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
            <rect x="3" y="3" width="26" height="26" rx="8" fill="#FFFFFF" />
            <path
              fill="#E01E5A"
              d="M13 6.5a2.5 2.5 0 1 1 0 5H10.5A2.5 2.5 0 1 1 10.5 6H13v.5Z"
            />
            <path
              fill="#36C5F0"
              d="M25.5 13A2.5 2.5 0 1 1 20.5 13V10.5A2.5 2.5 0 1 1 25 10.5V13h.5Z"
            />
            <path
              fill="#2EB67D"
              d="M19 25.5a2.5 2.5 0 1 1 0-5h2.5a2.5 2.5 0 1 1 0 5H19v-.5Z"
            />
            <path
              fill="#ECB22E"
              d="M6.5 19A2.5 2.5 0 1 1 11.5 19v2.5A2.5 2.5 0 1 1 7 21.5V19h-.5Z"
            />
            <path
              fill="#E01E5A"
              d="M11.7 7.7A2.5 2.5 0 0 1 16 9.5V16a2.5 2.5 0 1 1-5 0V9.5c0-.7.3-1.3.7-1.8Z"
            />
            <path
              fill="#36C5F0"
              d="M24.3 11.7A2.5 2.5 0 0 1 22.5 16H16a2.5 2.5 0 1 1 0-5h6.5c.7 0 1.3.3 1.8.7Z"
            />
            <path
              fill="#2EB67D"
              d="M20.3 24.3A2.5 2.5 0 0 1 16 22.5V16a2.5 2.5 0 1 1 5 0v6.5c0 .7-.3 1.3-.7 1.8Z"
            />
            <path
              fill="#ECB22E"
              d="M7.7 20.3A2.5 2.5 0 0 1 9.5 16H16a2.5 2.5 0 1 1 0 5H9.5c-.7 0-1.3-.3-1.8-.7Z"
            />
          </svg>
        </span>
      );
    case 'msteams':
      return (
        <span className="channel-logo" aria-hidden="true">
          <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
            <circle cx="23" cy="10" r="3.2" fill="#7B83EB" />
            <circle cx="25.2" cy="20.8" r="2.5" fill="#4F58CA" />
            <rect
              x="6.2"
              y="8.8"
              width="11.6"
              height="14.6"
              rx="2.6"
              fill="#5B61D6"
            />
            <rect
              x="11.6"
              y="10.4"
              width="10.4"
              height="12"
              rx="2.1"
              fill="#7B83EB"
            />
            <path fill="#FFFFFF" d="M9.3 13h7.8v2.1h-2.8v6.2h-2.3v-6.2H9.3z" />
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
