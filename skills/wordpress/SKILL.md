---
name: wordpress
description: Use this skill when the user wants WordPress workflows such as post or page drafting, wp-admin coordination, WP-CLI usage, plugin or theme inspection, or safe content publishing guidance.
user-invocable: true
metadata:
  hybridclaw:
    tags:
      - wordpress
      - cms
      - publishing
      - web
    install:
      - id: brew
        kind: brew
        formula: wp-cli
        bins: ["wp"]
        label: Install WP-CLI (brew)
    related_skills:
      - write-blog-post
      - stripe
---

# WordPress

Use this skill for WordPress content, admin, and site-maintenance workflows.

## Scope

- draft or update posts and pages
- inspect plugins, themes, users, and site settings
- coordinate wp-admin actions through the browser
- use WP-CLI when shell access to the site exists
- support safe publishing workflows for content teams

## Default Strategy

1. Confirm whether the target is a local, staging, or production site.
2. Prefer read-only inspection before any mutation.
3. Draft content first, then create a WordPress draft unless the user explicitly
   wants immediate publish.
4. Use WP-CLI when it is already available; otherwise use wp-admin or an
   existing REST integration.

## WP-CLI

Basic checks:

```bash
wp --info
wp core version
wp option get home
wp option get siteurl
```

Useful read commands:

```bash
wp post list --post_type=post --fields=ID,post_title,post_status,post_date
wp post get 123 --field=post_title
wp page list --fields=ID,post_title,post_status,post_date
wp plugin list
wp theme list
wp user list --fields=ID,user_login,user_email,roles
```

Draft-first content workflow:

```bash
wp post create --post_type=post --post_status=draft --post_title="Example Title"
wp post update 123 --post_status=draft
```

Use WP-CLI for content only when you know the site root and environment are
correct. Do not guess against an unknown production checkout.

## wp-admin Workflow

Use the browser when:

- the user is already signed in to wp-admin
- content editing is easier visually
- plugin or theme screens must be inspected
- the site uses custom fields or builders that WP-CLI does not represent well

Prepare the exact target before acting:

- site URL
- post or page id
- slug or title
- plugin or theme name
- whether the action is draft, update, publish, install, or delete

## Content Workflow

For blog content, draft outside WordPress first when possible:

1. outline or write the post
2. confirm title, slug, category, and publish state
3. create or update a draft
4. preview before publish

Default to drafts. Publishing should be explicit.

## REST API Guidance

If the site already exposes a safe authenticated REST path:

- read before write
- target one specific post, page, or media item at a time
- keep credentials outside the repo and out of chat

If no REST auth path exists, prefer WP-CLI or wp-admin instead of inventing one
mid-task.

## Working Rules

- Always state whether you are using WP-CLI, wp-admin, or REST.
- Never publish, delete, or update production plugins without explicit
  confirmation.
- Treat staging and production as separate targets; verify the environment
  before running write commands.
- For plugin or theme investigations, collect version and status before changing
  anything.
- If the site uses page builders or custom fields, prefer the admin UI unless
  there is a known automation path.

## Common Use Cases

- create or update a blog post draft
- inspect plugin and theme status
- find a page or post by title or id
- verify site URL, permalink, or user configuration
- coordinate safe content publishing on an existing WordPress site

## Pitfalls

- Do not assume the current shell directory is the correct WordPress install.
- Do not publish drafts by default.
- Do not install or update plugins on production just because an update exists.
- Do not treat custom-field-heavy sites as plain post-content workflows.
