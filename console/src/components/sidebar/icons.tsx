export type AppViewIconKind =
  | 'chat'
  | 'agents'
  | 'admin'
  | 'dashboard'
  | 'terminal'
  | 'gateway'
  | 'sessions'
  | 'channels'
  | 'models'
  | 'scheduler'
  | 'jobs'
  | 'audit'
  | 'skills'
  | 'plugins'
  | 'tools'
  | 'config'
  | 'cog'
  | 'docs'
  | 'github';

function IconFrame(props: { children: ReactNode; fill?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill={props.fill ? 'currentColor' : 'none'}
      stroke={props.fill ? 'none' : 'currentColor'}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {props.children}
    </svg>
  );
}

export function AppViewIcon(props: { kind: AppViewIconKind }) {
  switch (props.kind) {
    case 'chat':
      return (
        <IconFrame>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </IconFrame>
      );
    case 'agents':
      return (
        <IconFrame>
          <rect x="3" y="3" width="7" height="7" rx="2" />
          <rect x="14" y="3" width="7" height="7" rx="2" />
          <rect x="3" y="14" width="7" height="7" rx="2" />
          <rect x="14" y="14" width="7" height="7" rx="2" />
        </IconFrame>
      );
    case 'admin':
      return (
        <IconFrame>
          <path d="M12 3l7 4v10l-7 4-7-4V7l7-4z" />
          <path d="M12 8v8" />
          <path d="M8.5 10 12 8l3.5 2" />
        </IconFrame>
      );
    case 'dashboard':
      return (
        <IconFrame>
          <path d="M4 13.5a8 8 0 1 1 16 0" />
          <path d="M12 13l4-4" />
          <path d="M12 13v.01" />
        </IconFrame>
      );
    case 'terminal':
      return (
        <IconFrame>
          <path d="m5 7 4 5-4 5" />
          <path d="M13 17h6" />
        </IconFrame>
      );
    case 'gateway':
      return (
        <IconFrame>
          <path d="M12 3v18" />
          <path d="M6 7h6" />
          <path d="M6 17h6" />
          <path d="M12 12h6" />
        </IconFrame>
      );
    case 'sessions':
      return (
        <IconFrame>
          <rect x="4" y="5" width="16" height="12" rx="2.5" />
          <path d="M8 19h8" />
          <path d="M9 9h6" />
          <path d="M9 13h4" />
        </IconFrame>
      );
    case 'channels':
      return (
        <IconFrame>
          <path d="M9 4 7 20" />
          <path d="M17 4 15 20" />
          <path d="M4 9h16" />
          <path d="M3 15h16" />
        </IconFrame>
      );
    case 'models':
      return (
        <IconFrame>
          <ellipse cx="12" cy="6" rx="6.5" ry="2.5" />
          <path d="M5.5 6v6c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5V6" />
          <path d="M5.5 12v6c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5v-6" />
        </IconFrame>
      );
    case 'scheduler':
      return (
        <IconFrame>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 7v5l3 2" />
        </IconFrame>
      );
    case 'jobs':
      return (
        <IconFrame>
          <rect x="4" y="5" width="16" height="14" rx="2.5" />
          <path d="M8 9h8" />
          <path d="M8 13h5" />
          <path d="M8 17h7" />
        </IconFrame>
      );
    case 'audit':
      return (
        <IconFrame>
          <path d="M12 3 5 6v5c0 4.5 3 8.4 7 10 4-1.6 7-5.5 7-10V6l-7-3Z" />
          <path d="m9.5 12 1.7 1.7 3.3-3.7" />
        </IconFrame>
      );
    case 'skills':
      return (
        <IconFrame>
          <path d="M14 3h7v7" />
          <path d="M10 14 21 3" />
          <path d="M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" />
        </IconFrame>
      );
    case 'plugins':
      return (
        <IconFrame>
          <path d="M9 3v6" />
          <path d="M15 15v6" />
          <path d="M15 3v2" />
          <path d="M9 19v2" />
          <path d="M8 8h2a3 3 0 1 1 0 6H8a3 3 0 1 1 0-6Z" />
          <path d="M14 10h2a3 3 0 1 1 0 6h-2a3 3 0 1 1 0-6Z" />
        </IconFrame>
      );
    case 'tools':
      return (
        <IconFrame>
          <path d="m14.7 6.3 3 3" />
          <path d="m11.5 9.5 6.2 6.2" />
          <path d="m3 21 6.2-6.2" />
          <path d="M7.8 16.2 5 19l-2-2 2.8-2.8" />
          <path d="M14 4a4 4 0 0 0-4 5l-6 6 3 3 6-6a4 4 0 0 0 5-4Z" />
        </IconFrame>
      );
    case 'config':
    case 'cog':
      return (
        <IconFrame>
          <circle cx="12" cy="12" r="3.25" />
          <path d="M12 2.75v2.5" />
          <path d="M12 18.75v2.5" />
          <path d="m4.93 4.93 1.77 1.77" />
          <path d="m17.3 17.3 1.77 1.77" />
          <path d="M2.75 12h2.5" />
          <path d="M18.75 12h2.5" />
          <path d="m4.93 19.07 1.77-1.77" />
          <path d="m17.3 6.7 1.77-1.77" />
        </IconFrame>
      );
    case 'docs':
      return (
        <IconFrame>
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />
        </IconFrame>
      );
    case 'github':
      return (
        <svg
          aria-hidden="true"
          focusable="false"
          viewBox="0 0 16 16"
          fill="currentColor"
        >
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
        </svg>
      );
    default:
      return (
        <IconFrame>
          <circle cx="12" cy="12" r="3.25" />
        </IconFrame>
      );
  }
}
import type { ReactNode } from 'react';
