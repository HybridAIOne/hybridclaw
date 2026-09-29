import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PublishedTool,
  PublishedToolsState,
} from '../api/published-tools';
import { mockRouterBlocker, renderWithProviders } from '../test-utils';
import { PublishedToolsPage } from './published-tools';

vi.mock('@tanstack/react-router', () => mockRouterBlocker());

const fetchPublishedToolsMock = vi.fn<() => Promise<PublishedToolsState>>();
const savePublishedToolsMock =
  vi.fn<(token: string, tools: PublishedTool[]) => Promise<void>>();

vi.mock('../api/published-tools', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchPublishedTools: () => fetchPublishedToolsMock(),
  savePublishedTools: (token: string, tools: PublishedTool[]) =>
    savePublishedToolsMock(token, tools),
}));

vi.mock('../auth', () => ({
  useAuth: () => ({ token: 'test-token' }),
}));

const SALES_TOOL: PublishedTool = {
  name: 'ask_sales_pipeline',
  title: 'Sales pipeline',
  description: 'Use for Salesforce pipeline questions.',
  instructions: 'Use the salesforce skill.',
  agentId: 'sales',
  allowedTools: ['read'],
};

function makeState(
  overrides: Partial<PublishedToolsState> = {},
): PublishedToolsState {
  return {
    plugin: { status: 'loaded', error: null },
    tokenSet: true,
    tools: [SALES_TOOL],
    agentIds: ['main', 'sales'],
    defaultAgentId: 'main',
    ...overrides,
  };
}

describe('PublishedToolsPage', () => {
  beforeEach(() => {
    fetchPublishedToolsMock.mockReset();
    savePublishedToolsMock.mockReset();
    savePublishedToolsMock.mockResolvedValue();
  });

  it('shows the install command when the plugin is missing', async () => {
    fetchPublishedToolsMock.mockResolvedValue(makeState({ plugin: null }));
    renderWithProviders(<PublishedToolsPage />);
    expect(
      await screen.findByText(
        'hybridclaw plugin install ./plugins/published-tools',
      ),
    ).toBeTruthy();
  });

  it('lists tools and warns when the token is missing', async () => {
    fetchPublishedToolsMock.mockResolvedValue(makeState({ tokenSet: false }));
    renderWithProviders(<PublishedToolsPage />);
    expect(
      await screen.findByRole('button', { name: /Sales pipeline/ }),
    ).toBeTruthy();
    expect(screen.getByText('token missing')).toBeTruthy();
    expect(
      (screen.getByDisplayValue(/published-tools\/mcp$/) as HTMLInputElement)
        .value,
    ).toContain('/api/plugin-webhooks/published-tools/mcp');
  });

  it('adds a new tool to the existing list', async () => {
    fetchPublishedToolsMock.mockResolvedValue(makeState());
    renderWithProviders(<PublishedToolsPage />);
    await screen.findByRole('button', { name: /Sales pipeline/ });

    fireEvent.change(screen.getByPlaceholderText('ask_sales_pipeline'), {
      target: { value: 'translate_albanian' },
    });
    fireEvent.change(
      screen.getByPlaceholderText(/Use for questions about Salesforce/),
      { target: { value: 'Translate text to Albanian.' } },
    );
    fireEvent.change(screen.getByPlaceholderText(/^read/), {
      target: { value: 'read, bash\n' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save tool' }));

    await waitFor(() => expect(savePublishedToolsMock).toHaveBeenCalled());
    expect(savePublishedToolsMock.mock.calls[0]?.[1]).toEqual([
      SALES_TOOL,
      {
        name: 'translate_albanian',
        description: 'Translate text to Albanian.',
        instructions: '',
        allowedTools: ['read', 'bash'],
      },
    ]);
  });

  it('edits a tool in place and deletes it', async () => {
    fetchPublishedToolsMock.mockResolvedValue(makeState());
    renderWithProviders(<PublishedToolsPage />);
    fireEvent.click(
      await screen.findByRole('button', { name: /Sales pipeline/ }),
    );
    fireEvent.change(
      await screen.findByDisplayValue('Use the salesforce skill.'),
      {
        target: { value: 'Answer in one sentence.' },
      },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save tool' }));
    await waitFor(() =>
      expect(savePublishedToolsMock.mock.calls[0]?.[1]).toEqual([
        { ...SALES_TOOL, instructions: 'Answer in one sentence.' },
      ]),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete tool' }));
    await waitFor(() =>
      expect(savePublishedToolsMock.mock.calls[1]?.[1]).toEqual([]),
    );
  });

  it('shows the gateway reason when a save is rejected', async () => {
    fetchPublishedToolsMock.mockResolvedValue(makeState());
    savePublishedToolsMock.mockRejectedValue(
      new Error(
        'Plugin failed to load with this config: unknown agent "ghost".',
      ),
    );
    renderWithProviders(<PublishedToolsPage />);
    await screen.findByRole('button', { name: /Sales pipeline/ });
    fireEvent.click(screen.getByRole('button', { name: 'Save tool' }));
    expect(await screen.findByText(/unknown agent "ghost"/)).toBeTruthy();
  });
});
