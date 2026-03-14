---
name: stripe
description: Use this skill when the user wants Stripe workflows such as customer or subscription lookup, checkout/payment investigation, webhook testing, dashboard coordination, or Stripe CLI guidance.
user-invocable: true
metadata:
  hybridclaw:
    tags:
      - stripe
      - payments
      - billing
      - webhooks
      - enterprise
    related_skills:
      - feature-planning
      - code-review
---

# Stripe

Use this skill for Stripe Dashboard, Stripe CLI, and integration-debugging
workflows.

## Scope

- investigate customers, products, prices, payments, checkout sessions, and
  subscriptions
- debug webhook delivery and local webhook forwarding
- coordinate Dashboard actions through the browser when the user is already
  signed in
- draft safe operational steps for Stripe-backed app changes

## Default Strategy

1. Confirm whether the task is in test mode or live mode.
2. Prefer read-only inspection before any mutation.
3. Use Stripe CLI when a terminal workflow is available; otherwise use the
   Dashboard in the browser.
4. Confirm the exact object id or customer email before changing anything.

## Stripe CLI

Basic checks:

```bash
stripe version
stripe login
stripe config --list
```

Useful read commands:

```bash
stripe customers list --limit 10
stripe customers retrieve cus_123
stripe products list --limit 20
stripe prices list --product prod_123
stripe subscriptions retrieve sub_123
stripe payment_intents retrieve pi_123
stripe events list --limit 10
```

## Webhook Debugging

For local development, forward Stripe events to the app:

```bash
stripe listen --forward-to http://127.0.0.1:3000/api/stripe/webhook
```

Trigger common test events:

```bash
stripe trigger payment_intent.succeeded
stripe trigger checkout.session.completed
stripe trigger customer.subscription.created
```

When debugging webhook issues, capture:

- event id
- object id
- endpoint path
- HTTP status code
- whether the event came from test or live mode

## Dashboard Workflow

Use the Dashboard when the user is already authenticated in the browser or when
the CLI does not cover the needed operation cleanly.

Prepare the exact target first:

- customer email or id
- subscription id
- payment intent id
- product or price id
- refund or cancellation scope

Never click through destructive Dashboard actions until the user has confirmed
them explicitly.

## Working Rules

- Default to test mode unless the user explicitly says live mode.
- Never paste secret keys, restricted keys, or webhook signing secrets into
  chat.
- Do not create refunds, cancellations, or live charges without explicit
  confirmation.
- State whether you are using the CLI, the Dashboard, or application logs.
- For integration bugs, trace one concrete object or event end to end instead of
  reasoning in the abstract.

## Common Use Cases

- verify whether a checkout session completed
- inspect why a subscription did not activate
- replay or trigger webhook flows locally
- locate a customer, product, or price by known identifiers
- separate application bugs from Stripe configuration issues

## Pitfalls

- Do not confuse test objects with live objects.
- Do not assume webhook delivery order beyond the guarantees Stripe documents.
- Do not mutate billing state when a read-only investigation is enough.
- Do not debug payments using only app logs if Stripe event history is
  available.
