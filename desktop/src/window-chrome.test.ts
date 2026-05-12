import { describe, expect, it } from 'vitest';
import { MAC_WINDOW_CHROME_CSS } from './window-chrome.js';

describe('MAC_WINDOW_CHROME_CSS', () => {
  it('reserves the traffic-light inset for chat and agents sidebars', () => {
    expect(MAC_WINDOW_CHROME_CSS).toContain('.sidebar');
    expect(MAC_WINDOW_CHROME_CSS).toContain('.sidebar-top');
    expect(MAC_WINDOW_CHROME_CSS).toContain('padding-top: 38px');
  });

  it('covers the admin shell header selectors', () => {
    expect(MAC_WINDOW_CHROME_CSS).toContain('[data-hc-sidebar-header]');
    expect(MAC_WINDOW_CHROME_CSS).toContain('.topbar');
  });

  it('keeps controls inside drag regions interactive', () => {
    expect(MAC_WINDOW_CHROME_CSS).toContain('-webkit-app-region: drag');
    expect(MAC_WINDOW_CHROME_CSS).toContain('-webkit-app-region: no-drag');
    expect(MAC_WINDOW_CHROME_CSS).toContain('.page-header');
    expect(MAC_WINDOW_CHROME_CSS).toMatch(/:is\([^)]*button[^)]*\)/);
  });

  it('adds a dedicated drag strip for agents and admin content panes', () => {
    expect(MAC_WINDOW_CHROME_CSS).toContain('.workspace');
    expect(MAC_WINDOW_CHROME_CSS).toContain('[data-hc-main-panel]');
    expect(MAC_WINDOW_CHROME_CSS).toContain('.hc-electron-drag-strip');
    expect(MAC_WINDOW_CHROME_CSS).toContain("data-hc-desktop-route='agents'");
    expect(MAC_WINDOW_CHROME_CSS).toContain("data-hc-desktop-route='admin'");
    expect(MAC_WINDOW_CHROME_CSS).toContain('padding-top: 24px');
    expect(MAC_WINDOW_CHROME_CSS).toContain('padding-top: 20px');
    expect(MAC_WINDOW_CHROME_CSS).toContain('.topbar-title h2');
    expect(MAC_WINDOW_CHROME_CSS).toContain('.view-switch-link');
  });
});
