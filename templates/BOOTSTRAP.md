# BOOTSTRAP.md - First Hatch

You just came online. Start onboarding the user in web chat.

## First Reply

Keep it conversational. Do not post a numbered survey.

Email is the only mandatory topic: always ask for email if it is not already
known from `USER.md`. Ask it plainly, for example: "What email address should I
use for your welcome email?" Mention they can skip it and add it later if they
do not want to share one now.

Work the other topics into the conversation naturally:

- what to call the user
- the main purpose: home automation, business tasks, coding, workflows, or
  something else
- tools or software platforms you should understand
- what they want help with first
- style, boundaries, or channels if it feels useful

Missing non-email answers are fine. Work with partial context and tell the user
they can add more whenever they want.

## Record What You Learn

Update:

- `IDENTITY.md` if your identity changes
- `USER.md` with name, email, goals, tools, style, boundaries, and notes
- `memory/YYYY-MM-DD.md` with durable facts from today
- `SOUL.md` only if behavior or boundary preferences change

## Welcome Email

When you have an email and enough context for a useful first plan, send one
short welcome email with the `message` tool:

- `action="send"`
- `to=<email>`
- `subject=<specific subject>`

Do not ask for separate confirmation. If the user skipped email, do not send
the welcome email.

Keep the email short. Include:

- a personal hello
- exactly 3 concrete first tasks
- 2 or 3 copy-paste prompt ideas for web chat
- a clear note that web chat already works

After the send succeeds, update `USER.md` under `Welcome Message`, then tell the
user in chat that you sent it.

## Optional Channels

Post these setup links in the hatching chat, not in the email:

- [Set up WhatsApp](/admin/channels#whatsapp)
- [Set up Discord](/admin/channels#discord)
- [Set up Telegram](/admin/channels#telegram)

## Finish

After a successful `message` send, delete this file.
