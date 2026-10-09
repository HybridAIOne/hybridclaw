import { expect, test } from 'vitest';
import {
  runBrowserTakeOver,
  TAKE_OVER_RECORDER_SCRIPT,
  type TakeOverDeps,
} from '../container/src/browser-take-over.js';

// A browser on a sign-in page where the user signs in and opens invoices, and
// a gateway that says the user finished after `polls` polls.
function fakes(outcome: { remember: boolean }, polls = 2) {
  const commands: string[][] = [];
  const gatewayCalls: Array<{ path: string; body: Record<string, unknown> }> =
    [];
  const pages = [
    {
      url: 'https://shop.example/login?next=%2Faccount',
      title: 'Sign in',
      steps: [
        {
          kind: 'secret',
          label: 'Email',
          value: 'pat@example.com',
          page: 'https://shop.example/login',
        },
        {
          kind: 'secret',
          label: 'Password',
          page: 'https://shop.example/login',
        },
      ],
    },
    {
      url: 'https://shop.example/account/invoices',
      title: 'Invoices',
      steps: [
        // Written down on the sign-in page just before it left.
        {
          kind: 'click',
          role: 'button',
          label: 'Sign in',
          onclick: 'x()',
          page: 'https://shop.example/login',
        },
        {
          kind: 'fill',
          label: 'Search',
          value: 'October',
          page: 'https://shop.example/account/invoices',
        },
        { kind: 'unknown', label: 'ignored' },
      ],
    },
  ];
  let poll = 0;
  const deps: TakeOverDeps = {
    async browser(command, args) {
      commands.push([command, ...args]);
      if (command === 'stream') {
        return { success: true, data: { enabled: true, port: 41234 } };
      }
      if (command === 'eval' && args[0] === TAKE_OVER_RECORDER_SCRIPT) {
        const page = pages[Math.min(poll, pages.length - 1)];
        return { success: true, data: { result: page } };
      }
      if (command === 'eval') {
        return {
          success: true,
          data: {
            result: {
              url: 'https://shop.example/login',
              title: 'Sign in',
              width: 1280,
              height: 720,
              scale: 1,
            },
          },
        };
      }
      return { success: true, data: {} };
    },
    async gateway(path, body) {
      gatewayCalls.push({ path, body });
      if (path === '/api/browser/take-over') return { id: 'take-1' };
      if (path === '/api/browser/take-over/status') {
        poll += 1;
        return poll >= polls
          ? { state: 'finished', remember: outcome.remember }
          : { state: 'active', remember: false };
      }
      return { closed: true };
    },
    async sleep() {},
    now: () => 0,
  };
  return { deps, commands, gatewayCalls };
}

test('a task shown once comes back as steps, with nothing secret in them', async () => {
  const { deps, commands, gatewayCalls } = fakes({ remember: true });
  const result = await runBrowserTakeOver(
    'main-abc',
    { reason: 'Show me how' },
    deps,
  );

  expect(gatewayCalls[0]).toEqual({
    path: '/api/browser/take-over',
    body: { sessionId: 'main-abc', port: 41234, reason: 'Show me how' },
  });
  expect(result).toMatchObject({
    taken_over: true,
    remember: true,
    url: 'https://shop.example/account/invoices',
    title: 'Invoices',
    steps: [
      '1. Was on https://shop.example/login ("Sign in")',
      '2. Typed a sign-in, password or code into "Email" (not recorded)',
      '3. Typed a sign-in, password or code into "Password" (not recorded)',
      '4. Clicked the button "Sign in"',
      '5. Was on https://shop.example/account/invoices ("Invoices")',
      '6. Typed "October" into "Search"',
    ],
  });
  expect(JSON.stringify(result)).not.toContain('pat@example.com');
  expect(JSON.stringify(result)).not.toContain('next=');
  // A phone-sized page while the user drives, the agent's size afterwards.
  expect(commands).toContainEqual(['set', 'viewport', '400', '820', '2']);
  expect(commands.at(-1)).toEqual(['set', 'viewport', '1280', '720', '1']);
  expect(gatewayCalls.at(-1)?.path).toBe('/api/browser/take-over/close');
});

test('handing the browser back tells the agent to carry on, without the steps', async () => {
  const { deps } = fakes({ remember: false });
  const result = await runBrowserTakeOver('main-abc', { reason: 'Sign in' }, deps);
  expect(result).toMatchObject({ taken_over: true });
  expect(result.steps).toBeUndefined();
  expect(String(result.next)).toContain('continue the task');
});

test('without an open page there is nothing to hand over', async () => {
  const { deps, gatewayCalls } = fakes({ remember: false });
  const blank: TakeOverDeps = {
    ...deps,
    async browser(command, args) {
      if (command === 'eval') {
        return { success: true, data: { result: { url: 'about:blank' } } };
      }
      return deps.browser(command, args);
    },
  };
  await expect(runBrowserTakeOver('main-abc', {}, blank)).rejects.toThrow(
    'open the page first',
  );
  expect(gatewayCalls).toEqual([]);
});
