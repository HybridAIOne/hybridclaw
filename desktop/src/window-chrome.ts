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

  :is(.sidebar-top, .chat-topbar, .page-header, .topbar, [data-hc-sidebar-header])
  :is(a, button, input, select, textarea, summary, [role='button'], [role='link'], [contenteditable='true']) {
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

  :root[data-hc-desktop-route='admin'] .topbar {
    -webkit-app-region: no-drag;
  }

  :root[data-hc-desktop-route='admin'] .topbar-title,
  :root[data-hc-desktop-route='admin'] .topbar-heading,
  :root[data-hc-desktop-route='admin'] .topbar-title h2 {
    -webkit-app-region: drag;
    user-select: none;
  }

  :root[data-hc-desktop-route='admin'] .view-switch,
  :root[data-hc-desktop-route='admin'] .view-switch *,
  :root[data-hc-desktop-route='admin'] .view-switch-link {
    -webkit-app-region: no-drag;
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
