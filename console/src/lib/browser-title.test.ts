import { describe, expect, it } from 'vitest';
import { resolveBrowserTitle } from './browser-title';

describe('resolveBrowserTitle', () => {
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
