import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LATEST_RELEASE_NOTES } from '../release-notes';
import { WhatsNew } from './whats-new';

const SEEN_VERSION_STORAGE_KEY = 'hybridclaw_whats_new_seen_version';

describe('WhatsNew', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(cleanup);

  it('automatically opens once for the current release', () => {
    const { unmount } = render(
      <WhatsNew version={LATEST_RELEASE_NOTES.version} />,
    );

    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).getByText(
        `What's new in v${LATEST_RELEASE_NOTES.version}`,
      ),
    ).toBeDefined();
    expect(localStorage.getItem(SEEN_VERSION_STORAGE_KEY)).toBe(
      LATEST_RELEASE_NOTES.version,
    );

    unmount();
    render(<WhatsNew version={LATEST_RELEASE_NOTES.version} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reopens when the version number is clicked', () => {
    localStorage.setItem(
      SEEN_VERSION_STORAGE_KEY,
      LATEST_RELEASE_NOTES.version,
    );
    render(<WhatsNew version={LATEST_RELEASE_NOTES.version} />);

    fireEvent.click(
      screen.getByRole('button', {
        name: `What's new in v${LATEST_RELEASE_NOTES.version}`,
      }),
    );

    expect(screen.getByRole('dialog')).toBeDefined();
    expect(screen.getByText('HybridClaw update')).toBeDefined();
    expect(
      screen.queryByText('A quick look at this HybridClaw release.'),
    ).toBeNull();
    for (const highlight of LATEST_RELEASE_NOTES.highlights) {
      expect(screen.getByText(highlight)).toBeDefined();
    }
  });

  it('does not automatically open for an unmatched runtime version', () => {
    render(<WhatsNew version="0.0.0-dev" />);

    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: "What's new in v0.0.0-dev" }),
    );
    expect(screen.getByRole('dialog')).toBeDefined();
    expect(
      screen.getByRole('link', { name: 'Full release notes' }),
    ).toBeDefined();
  });
});
