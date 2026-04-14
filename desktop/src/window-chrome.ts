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

  :root[data-hc-desktop-route='agents'] .workspace,
  :root[data-hc-desktop-route='agents'] [data-hc-main-panel],
  :root[data-hc-desktop-route='admin'] [data-hc-main-panel] {
    position: relative;
    background: var(--page-bg, #ffffff) !important;
  }

  :root[data-hc-desktop-route='agents'] .workspace,
  :root[data-hc-desktop-route='agents'] [data-hc-main-panel] {
    padding-top: 24px !important;
  }

  :root[data-hc-desktop-route='admin'] [data-hc-main-panel] {
    padding-top: 20px !important;
  }

  :root[data-hc-desktop-route='admin'] [data-hc-sidebar-root] {
    box-sizing: border-box;
    padding-top: 38px !important;
  }

  :root[data-hc-desktop-route='admin'] [data-hc-sidebar-header] {
    padding-top: 4px !important;
    padding-bottom: 12px !important;
  }

  .hc-electron-drag-strip {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 1;
    -webkit-app-region: drag;
  }

  :root[data-hc-desktop-route='agents'] .hc-electron-drag-strip {
    height: 24px;
  }

  :root[data-hc-desktop-route='admin'] .hc-electron-drag-strip {
    height: 20px;
  }

  :root[data-hc-desktop-route='agents'] .workspace > :not(.hc-electron-drag-strip),
  :root[data-hc-desktop-route='agents'] [data-hc-main-panel] > :not(.hc-electron-drag-strip),
  :root[data-hc-desktop-route='admin'] [data-hc-main-panel] > :not(.hc-electron-drag-strip) {
    position: relative;
    z-index: 2;
  }
`;
