---
name: inbox-cleanup
description: Tidy a crowded inbox by archiving newsletters, promotions and notifications in bulk, with a card the user approves and undo for 30 days. Use when the user wants to clean up, declutter or sort their inbox, get rid of newsletters or promotions, or has thousands of unread emails.
user-invocable: false
metadata:
  hybridclaw:
    category: productivity
    short_description: "Archive bulk mail in sender groups, with a preview and undo."
    tags:
      - email
      - inbox
      - cleanup
      - archive
      - newsletters
---
# Inbox Clean-up

You can archive mail in bulk with `inbox_cleanup`. You cannot delete mail, and
you never try to.

## How

1. Call `inbox_cleanup` with `action: plan`. It looks at the newest inbox mail
   by sender and mail headers and changes nothing.
2. Say in one or two sentences what it found: how many emails it can archive and
   the two or three biggest senders. The card shows the rest, so don't list
   every group.
3. Call `action: apply` with the plan's `preselected` groups. The user sees a
   card with the groups and decides there. Add a group the plan did not
   preselect, or leave one out, only when the user asks ("keep the Club mails").
4. Report the numbers from the result: archived, skipped and why, not moved.
   Say once that undo works for 30 days. If the result has `stopped_because`,
   say what moved before it stopped.
5. When the user wants it back, call `action: undo` with the same `plan_id`.

## Rules

- Mail moves only through `inbox_cleanup`. Never use the browser, a script or
  the shell to move, flag or delete mail, even if the user asks. That is how
  accounts get locked and mail gets lost.
- If the user asks you to delete, empty the trash or remove mail for good, say
  that you only archive: archived mail is out of the inbox and never expires.
  If they still want it gone, they can delete the Archive folder's mail in their
  mail app themselves.
- Never decide by words in a subject. "Offer", "invoice" or "deal" says nothing
  about who sent it. Trust the plan's groups.
- Never say you read or checked emails you did not open. Say you sorted them
  "by sender and mail headers", because that is what the plan does.
- Numbers come from tool results. If the plan says 2,140, don't round it.
- The plan leaves alone mail from people the user writes to, starred mail,
  senders the user replied to, this week's mail and mail without bulk headers.
  Don't offer to include them.
- A weekly tidy-up is a scheduled task that runs `plan` and tells the user what
  it found. It never archives without the user approving the card.
- If `plan` or `apply` says the mailbox can't do it (no Archive folder, a server
  that can't report moves), say so in one sentence and stop. Don't try another
  way.
