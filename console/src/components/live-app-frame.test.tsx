import { act, fireEvent, render } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { LiveAppFrame, type LiveAppFrameHandle } from './live-app-frame';

vi.mock('../api/apps', () => ({
  appViewUrl: (id: string, token: string) => `/app/${id}?token=${token}`,
  callLiveAppTool: vi.fn(),
}));

describe('LiveAppFrame', () => {
  it('posts a live refresh request to the embedded app', () => {
    const ref = createRef<LiveAppFrameHandle>();
    const { container } = render(
      <LiveAppFrame ref={ref} appId="app-1" title="Live App" token="token-1" />,
    );
    const iframe = container.querySelector('iframe');
    expect(iframe).toBeTruthy();
    const target = iframe?.contentWindow;
    expect(target).toBeTruthy();
    const postMessage = vi
      .spyOn(target as Window, 'postMessage')
      .mockImplementation(() => undefined);

    let posted = false;
    act(() => {
      fireEvent.load(iframe as HTMLIFrameElement);
      posted = ref.current?.refreshData() ?? false;
    });

    expect(posted).toBe(true);
    expect(postMessage).toHaveBeenCalledWith(
      {
        type: 'hybridclaw:live-app-refresh',
        appId: 'app-1',
      },
      '*',
    );
  });
});
