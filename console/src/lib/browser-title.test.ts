import { describe, expect, it } from 'vitest';
import {
  resolveBrowserTitle,
  setChatUnreadCount,
  updateBrowserTitle,
} from './browser-title';

describe('resolveBrowserTitle', () => {
  it('keeps unread badges across chat navigation and clears them outside chat', () => {
    setChatUnreadCount(2);
    updateBrowserTitle('/chat/session-b');
    expect(document.title).toMatch(/^\(2\) /);
    updateBrowserTitle('/admin');
    expect(document.title).not.toMatch(/^\(/);
    setChatUnreadCount(0);
  });
  it('uses chat title for chat routes', () => {
    expect(resolveBrowserTitle('/chat')).toBe('HybridClaw Chat');
    expect(resolveBrowserTitle('/chat/session-1')).toBe('HybridClaw Chat');
  });

  it('names the pages beside chat', () => {
    expect(resolveBrowserTitle('/chat/ideas')).toBe('HybridClaw Ideas');
    expect(resolveBrowserTitle('/apps')).toBe('HybridClaw Apps');
  });

  it('uses admin title only for admin routes', () => {
    expect(resolveBrowserTitle('/admin')).toBe('HybridClaw Admin');
    expect(resolveBrowserTitle('/admin/config')).toBe('HybridClaw Admin');
    expect(resolveBrowserTitle('/agents')).toBe('HybridClaw Agents');
  });
});
