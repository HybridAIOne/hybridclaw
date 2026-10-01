import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { TrustedAgentApprovalRuntime } from '../container/src/approval-policy.js';
import {
  classifyBrowserCheckout,
  isCheckoutPage,
  isPurchaseLabel,
  recordBrowserPage,
  recordBrowserSnapshotRefs,
  resetBrowserPage,
} from '../container/src/browser-checkout.js';
import type { ChatMessage } from '../container/src/types.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-checkout-approval-');
useCleanMocks({ unstubAllEnvs: true });
afterEach(() => resetBrowserPage());

function createRuntime(mode: 'auto' | 'full' = 'auto') {
  const dir = makeTempDir();
  const runtime = new TrustedAgentApprovalRuntime(
    path.join(dir, 'policy.yaml'),
    path.join(dir, 'agent-trust.json'),
    path.join(dir, 'all-trust.json'),
    path.join(dir, 'legacy-trust.json'),
    undefined,
    path.join(dir, 'pending.json'),
  );
  runtime.setApprovalMode({ mode });
  return runtime;
}

function evaluate(
  runtime: TrustedAgentApprovalRuntime,
  toolName: string,
  args: Record<string, unknown>,
) {
  return runtime.evaluateToolCall({
    toolName,
    argsJson: JSON.stringify(args),
    latestUserPrompt: 'Order the usual coffee beans',
  });
}

function userMessage(content: string): ChatMessage {
  return { role: 'user', content };
}

function onCheckout(): void {
  recordBrowserPage({
    url: 'https://www.shop.example/checkout/review?session=abc',
    title: 'Review your order',
  });
  recordBrowserSnapshotRefs({
    e4: { role: 'button', name: 'Back to cart' },
    e9: { role: 'button', name: 'Place your order' },
  });
}

describe('purchase labels', () => {
  test.each([
    'Place order',
    'Place your order',
    'Buy now',
    'Buy',
    'Pay €23.99',
    'Pay with PayPal',
    'Confirm and pay',
    'Complete purchase',
    'Submit order',
    'Book now',
    'Zahlungspflichtig bestellen',
    'Kostenpflichtig bestellen',
    'Jetzt kaufen',
    'Bestellung abschließen',
    'Kaufen',
  ])('%s buys', (label) => {
    expect(isPurchaseLabel(label)).toBe(true);
  });

  test.each([
    'Proceed to checkout',
    'Checkout',
    'Add to cart',
    'In den Warenkorb',
    'Zur Kasse',
    'Payment methods',
    'Buying guide',
    'Weiter',
    '',
  ])('%s does not buy', (label) => {
    expect(isPurchaseLabel(label)).toBe(false);
  });

  test('recognises checkout pages by their path', () => {
    expect(isCheckoutPage('https://shop.example/checkout/payment')).toBe(true);
    expect(isCheckoutPage('https://shop.example/kasse')).toBe(true);
    expect(isCheckoutPage('https://shop.example/products/checkout-mug')).toBe(
      false,
    );
    expect(isCheckoutPage('https://shop.example/cart')).toBe(false);
  });
});

describe('browser checkout classification', () => {
  test('reads a ref click label from the last snapshot', () => {
    onCheckout();
    expect(classifyBrowserCheckout('browser_click', { ref: '@e9' })).toEqual({
      host: 'shop.example',
      label: 'Place your order',
      url: 'https://www.shop.example/checkout/review?session=abc',
    });
    expect(classifyBrowserCheckout('browser_click', { ref: 'e4' })).toBeNull();
  });

  test('on a checkout page, unnamed clicks and Enter ask first', () => {
    onCheckout();
    expect(
      classifyBrowserCheckout('browser_click', { x: 420, y: 610 }),
    ).toMatchObject({ host: 'shop.example', label: '' });
    expect(
      classifyBrowserCheckout('browser_press', { key: 'Enter' }),
    ).toMatchObject({ host: 'shop.example' });
    expect(classifyBrowserCheckout('browser_press', { key: 'Tab' })).toBeNull();
  });

  test('off a checkout page, only a buying label counts', () => {
    recordBrowserPage({ url: 'https://news.example/today', title: 'News' });
    expect(classifyBrowserCheckout('browser_click', { x: 1, y: 2 })).toBeNull();
    expect(
      classifyBrowserCheckout('browser_click', { text: 'Buy now' }),
    ).toMatchObject({ host: 'news.example', label: 'Buy now' });
    expect(
      classifyBrowserCheckout('browser_click', { selector: '#placeOrder' }),
    ).toMatchObject({ host: 'news.example' });
  });

  test('a new page forgets the old refs', () => {
    onCheckout();
    recordBrowserPage({ url: 'https://www.shop.example/thanks' });
    expect(classifyBrowserCheckout('browser_click', { ref: '@e9' })).toBeNull();
  });
});

describe('checkout approvals', () => {
  test('a purchase click asks, even in full mode', () => {
    for (const mode of ['auto', 'full'] as const) {
      onCheckout();
      const evaluation = evaluate(createRuntime(mode), 'browser_click', {
        ref: '@e9',
      });
      expect(evaluation, mode).toMatchObject({
        tier: 'red',
        pinned: true,
        decision: 'required',
        actionKey: 'browser_purchase:shop.example',
        intent: 'place an order on shop.example (button "Place your order")',
        requestId: expect.any(String),
      });
    }
  });

  test('approval covers one order only', () => {
    onCheckout();
    const runtime = createRuntime();
    expect(evaluate(runtime, 'browser_click', { ref: '@e9' }).decision).toBe(
      'required',
    );
    expect(
      runtime.handleApprovalResponse([userMessage('yes for session')])
        ?.approvalMode,
    ).toBe('once');
    expect(evaluate(runtime, 'browser_click', { ref: '@e9' }).decision).toBe(
      'approved_once',
    );
    expect(evaluate(runtime, 'browser_click', { ref: '@e9' }).decision).toBe(
      'required',
    );
  });

  test('ordinary browsing stays quiet', () => {
    onCheckout();
    expect(
      evaluate(createRuntime(), 'browser_click', { ref: '@e4' }),
    ).toMatchObject({ tier: 'yellow', decision: 'implicit' });
  });
});
