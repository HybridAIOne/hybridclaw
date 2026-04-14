export const MAC_WINDOW_CHROME_CSS = `
  .sidebar {
    padding-top: 38px !important;
  }

  .sidebar-top {
    padding-top: 6px !important;
  }

  .sidebar-top,
  .chat-topbar,
  .page-header,
  .topbar,
  [data-hc-sidebar-header] {
    -webkit-app-region: drag;
    user-select: none;
  }

  .sidebar-top a,
  .sidebar-top button,
  .sidebar-top input,
  .sidebar-top select,
  .sidebar-top textarea,
  .sidebar-top summary,
  .sidebar-top [role='button'],
  .sidebar-top [role='link'],
  .sidebar-top [contenteditable='true'],
  .chat-topbar a,
  .chat-topbar button,
  .chat-topbar input,
  .chat-topbar select,
  .chat-topbar textarea,
  .chat-topbar summary,
  .chat-topbar [role='button'],
  .chat-topbar [role='link'],
  .chat-topbar [contenteditable='true'],
  .page-header a,
  .page-header button,
  .page-header input,
  .page-header select,
  .page-header textarea,
  .page-header summary,
  .page-header [role='button'],
  .page-header [role='link'],
  .page-header [contenteditable='true'],
  .topbar a,
  .topbar button,
  .topbar input,
  .topbar select,
  .topbar textarea,
  .topbar summary,
  .topbar [role='button'],
  .topbar [role='link'],
  .topbar [contenteditable='true'],
  [data-hc-sidebar-header] a,
  [data-hc-sidebar-header] button,
  [data-hc-sidebar-header] input,
  [data-hc-sidebar-header] select,
  [data-hc-sidebar-header] textarea,
  [data-hc-sidebar-header] summary,
  [data-hc-sidebar-header] [role='button'],
  [data-hc-sidebar-header] [role='link'],
  [data-hc-sidebar-header] [contenteditable='true'] {
    -webkit-app-region: no-drag;
  }

  [data-hc-sidebar-header] {
    padding-top: 44px !important;
  }

  .workspace,
  [data-hc-main-panel] {
    position: relative;
    padding-top: 56px !important;
    background: var(--page-bg, #ffffff) !important;
    -webkit-app-region: drag;
  }

  .workspace *,
  [data-hc-main-panel] * {
    -webkit-app-region: no-drag;
  }
`;
