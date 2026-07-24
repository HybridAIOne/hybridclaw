import { expect, test, vi } from 'vitest';

import { MSTeamsStreamManager } from '../src/channels/msteams/stream.js';

test('uses the Teams streaminfo protocol for direct-message progress and text', async () => {
  vi.useFakeTimers();
  try {
    const sendActivity = vi
      .fn()
      .mockResolvedValueOnce({ id: 'stream-1' })
      .mockResolvedValue(undefined);
    const turnContext = {
      sendActivity,
      updateActivity: vi.fn(async () => {}),
      deleteActivity: vi.fn(async () => {}),
    };
    const stream = new MSTeamsStreamManager(turnContext as never, {
      replyStyle: 'thread',
      replyToId: 'incoming-1',
      editIntervalMs: 500,
      nativeStreaming: true,
    });

    await stream.updateInformative();
    expect(sendActivity).toHaveBeenNthCalledWith(1, {
      type: 'typing',
      text: 'Thinking…',
      entities: [
        {
          type: 'streaminfo',
          streamType: 'informative',
          streamSequence: 1,
        },
      ],
    });

    await stream.updateInformative('Searching…');
    expect(sendActivity).toHaveBeenNthCalledWith(2, {
      type: 'typing',
      text: 'Searching…',
      entities: [
        {
          type: 'streaminfo',
          streamId: 'stream-1',
          streamType: 'informative',
          streamSequence: 2,
        },
      ],
    });

    await stream.append('Hello');
    await vi.advanceTimersByTimeAsync(0);
    expect(sendActivity).toHaveBeenNthCalledWith(3, {
      type: 'typing',
      text: 'Hello',
      entities: [
        {
          type: 'streaminfo',
          streamId: 'stream-1',
          streamType: 'streaming',
          streamSequence: 3,
        },
      ],
    });

    await stream.finalize('Hello world');
    expect(sendActivity).toHaveBeenNthCalledWith(4, {
      type: 'message',
      text: 'Hello world',
      entities: [
        {
          type: 'streaminfo',
          streamId: 'stream-1',
          streamType: 'final',
        },
      ],
    });
  } finally {
    vi.useRealTimers();
  }
});

test('falls back to normal Teams messages when native streaming is unavailable', async () => {
  const sendActivity = vi
    .fn()
    .mockRejectedValueOnce({ statusCode: 403 })
    .mockResolvedValueOnce({ id: 'activity-1' });
  const turnContext = {
    sendActivity,
    updateActivity: vi.fn(async () => {}),
    deleteActivity: vi.fn(async () => {}),
  };
  const stream = new MSTeamsStreamManager(turnContext as never, {
    replyStyle: 'thread',
    replyToId: 'incoming-1',
    nativeStreaming: true,
  });

  await stream.updateInformative();
  expect(stream.isNativeStreamingActive()).toBe(false);

  await stream.finalize('Fallback reply');
  expect(sendActivity).toHaveBeenNthCalledWith(2, {
    type: 'message',
    text: 'Fallback reply',
    replyToId: 'incoming-1',
  });
});

test('delivers the full reply when Teams rejects native stream finalization', async () => {
  const sendActivity = vi
    .fn()
    .mockResolvedValueOnce({ id: 'stream-1' })
    .mockRejectedValueOnce({ statusCode: 403 })
    .mockResolvedValueOnce({ id: 'activity-1' });
  const deleteActivity = vi.fn(async () => {});
  const turnContext = {
    sendActivity,
    updateActivity: vi.fn(async () => {}),
    deleteActivity,
  };
  const stream = new MSTeamsStreamManager(turnContext as never, {
    replyStyle: 'thread',
    replyToId: 'incoming-1',
    nativeStreaming: true,
  });

  await stream.updateInformative();
  await stream.finalize('Complete reply');

  expect(deleteActivity).toHaveBeenCalledWith('stream-1');
  expect(sendActivity).toHaveBeenNthCalledWith(3, {
    type: 'message',
    text: 'Complete reply',
    replyToId: 'incoming-1',
  });
});

test('honors a user cancellation instead of redelivering the reply', async () => {
  const sendActivity = vi
    .fn()
    .mockResolvedValueOnce({ id: 'stream-1' })
    .mockRejectedValueOnce({
      response: {
        status: 403,
        data: {
          error: {
            code: 'ContentStreamNotAllowed',
            message: 'Content stream was canceled by user.',
          },
        },
      },
    });
  const deleteActivity = vi.fn(async () => {});
  const onNativeCancellation = vi.fn();
  const turnContext = {
    sendActivity,
    updateActivity: vi.fn(async () => {}),
    deleteActivity,
  };
  const stream = new MSTeamsStreamManager(turnContext as never, {
    replyStyle: 'thread',
    replyToId: 'incoming-1',
    nativeStreaming: true,
    onNativeCancellation,
  });

  await stream.updateInformative();
  await stream.finalize('Do not redeliver this reply');

  expect(onNativeCancellation).toHaveBeenCalledTimes(1);
  expect(sendActivity).toHaveBeenCalledTimes(2);
  expect(deleteActivity).not.toHaveBeenCalled();
});

test('finalize omits the text field for attachment-only Teams stream sends', async () => {
  const sendActivity = vi.fn(async () => ({ id: 'activity-1' }));
  const turnContext = {
    sendActivity,
    updateActivity: vi.fn(async () => {}),
    deleteActivity: vi.fn(async () => {}),
  };
  const attachments = [
    {
      contentType: 'image/png',
      contentUrl: 'https://example.com/image.png',
      name: 'image.png',
    },
  ];

  const stream = new MSTeamsStreamManager(turnContext as never, {
    replyStyle: 'thread',
    replyToId: 'incoming-1',
  });
  await stream.finalize('', attachments);

  expect(sendActivity).toHaveBeenCalledWith({
    type: 'message',
    attachments,
    replyToId: 'incoming-1',
  });
});

test('append throttles Teams stream edits instead of syncing every delta', async () => {
  vi.useFakeTimers();
  try {
    const sendActivity = vi.fn(async () => ({ id: 'activity-1' }));
    const updateActivity = vi.fn(async () => {});
    const turnContext = {
      sendActivity,
      updateActivity,
      deleteActivity: vi.fn(async () => {}),
    };

    const stream = new MSTeamsStreamManager(turnContext as never, {
      replyStyle: 'thread',
      replyToId: 'incoming-1',
      editIntervalMs: 500,
    });

    await stream.append('Hel');
    await stream.append('lo');
    expect(sendActivity).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(0);
    expect(sendActivity).toHaveBeenCalledTimes(1);
    expect(sendActivity).toHaveBeenCalledWith({
      type: 'message',
      text: 'Hello',
      replyToId: 'incoming-1',
    });

    await stream.append(' world');
    expect(updateActivity).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(499);
    expect(updateActivity).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(updateActivity).toHaveBeenCalledTimes(1);
    expect(updateActivity).toHaveBeenCalledWith({
      id: 'activity-1',
      type: 'message',
      text: 'Hello world',
      replyToId: 'incoming-1',
    });

    await vi.advanceTimersByTimeAsync(500);
    expect(updateActivity).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

test('append surfaces send failures with a terminal Teams error message', async () => {
  vi.useFakeTimers();
  try {
    const sendActivity = vi
      .fn()
      .mockRejectedValueOnce(new Error('transport down'))
      .mockResolvedValueOnce({ id: 'activity-1' });
    const turnContext = {
      sendActivity,
      updateActivity: vi.fn(async () => {}),
      deleteActivity: vi.fn(async () => {}),
    };

    const stream = new MSTeamsStreamManager(turnContext as never, {
      replyStyle: 'thread',
      replyToId: 'incoming-1',
      editIntervalMs: 500,
    });

    await stream.append('Hello');
    await vi.advanceTimersByTimeAsync(0);

    expect(sendActivity).toHaveBeenCalledTimes(2);
    expect(sendActivity).toHaveBeenNthCalledWith(1, {
      type: 'message',
      text: 'Hello',
      replyToId: 'incoming-1',
    });
    expect(sendActivity).toHaveBeenNthCalledWith(2, {
      type: 'message',
      text: 'Hello\n\nTeams streaming was interrupted while sending the reply. Please retry.',
      replyToId: 'incoming-1',
    });

    await stream.append(' again');
    await vi.advanceTimersByTimeAsync(500);
    expect(sendActivity).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

test('stream retries transient Teams send and update failures', async () => {
  vi.useFakeTimers();
  try {
    const sendActivity = vi
      .fn()
      .mockRejectedValueOnce({ statusCode: 429, retryAfter: 0.05 })
      .mockResolvedValueOnce({ id: 'activity-1' });
    const updateActivity = vi
      .fn()
      .mockRejectedValueOnce({ statusCode: 503 })
      .mockResolvedValueOnce(undefined);
    const turnContext = {
      sendActivity,
      updateActivity,
      deleteActivity: vi.fn(async () => {}),
    };

    const stream = new MSTeamsStreamManager(turnContext as never, {
      replyStyle: 'thread',
      replyToId: 'incoming-1',
      editIntervalMs: 500,
    });

    await stream.append('Hello');
    await vi.advanceTimersByTimeAsync(0);
    expect(sendActivity).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(49);
    expect(sendActivity).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(sendActivity).toHaveBeenCalledTimes(2);

    await stream.append(' world');
    await vi.advanceTimersByTimeAsync(500);
    expect(updateActivity).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(499);
    expect(updateActivity).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(updateActivity).toHaveBeenCalledTimes(2);
    expect(updateActivity).toHaveBeenNthCalledWith(2, {
      id: 'activity-1',
      type: 'message',
      text: 'Hello world',
      replyToId: 'incoming-1',
    });
  } finally {
    vi.useRealTimers();
  }
});
