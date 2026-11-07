---
name: brain
description: >
  Proposes lessons from the current task for the user's Brain/ knowledge base in SilverBullet
  (development and architecture), and writes only what the user approves, point by point.
  Use at the end of a task that taught something reusable, when the user says "brain",
  "retiens ça", "à garder", or asks what they already know on a topic.
  Args: none (harvest lessons), "reindex" (index pages missing from Brain/Index), "audit" (one-off graph analysis).
---

# Brain

`Brain/` in SilverBullet is the user's second brain: general, reusable knowledge in development and architecture. Project-specific facts belong to the project's page (`/sb-refresh`), never here.

`Brain/Index.md` is the map of what the user already knows: one line per knowledge page, grouped by theme (`## Git et outils`, `## Sécurité`, `## PostgreSQL`, …), `*(vide)*` marking a stub page. Read it before proposing anything; keep it current after every write.

All access goes through `sb` (`sb ls`, `sb get`, `sb put`), with the global CLAUDE.md rules. Work on copies in the session's scratchpad.

## Harvest (no argument)

1. **Read the index.** `sb get "Brain/Index.md"`. If it is missing, stop and say so.
2. **Harvest lessons.** From what this task actually established (a gotcha hit, a pattern that worked, a concept that had to be learned), keep each **lesson** that is durable, general and verified in this session. Drop what the index or its pages already state: for a candidate near an existing line, `sb get` that page and check.
3. **Propose, numbered.** For each lesson, one block in French:
   - **N. Titre** — nouvelle page `Brain/<chemin>.md` (under the Category it belongs to) *or* complément à `Brain/<page existante>.md` (which section).
   - The full draft text to be written, in the page conventions below.
   Nothing is written in this step. When no lesson qualifies, say so in one line and stop.
4. **Approval, point by point.** Ask with AskUserQuestion (multiSelect, one option per lesson, label = number + title). Only the lessons chosen are written; a lesson the user amends is written as amended.
5. **Write each approved lesson** (procedure below), then **update the index**: add or amend its line in the right theme section (create the section if no theme fits), set `updated:` to today.
6. **Report**: each page written, with its path, and the index lines changed.

The step is complete when every approved lesson is on its page, linked from its Category page, listed in the index, and each written page was re-read and matches the copy that was put.

## Page conventions

Match the existing pages (read one sibling page before writing):

```markdown
---
type: Topic
links:
  - "[[Brain/<Category path>|<Category title>]]"
tags:
  - <lowercase-tag>
field: <web-dev | databases | …, as the siblings use>
external-links:
  - "[<title>](<url>)"
created: <YYYY-MM-DD>
---
# Description

<what it is, when to use it, in 2-6 lines>
# Examples

<code or concrete cases>
```

- Language: pages are written in English; the proposal to the user and the index summaries stay in French.
- Links: full-path wiki links (`[[Brain/DEVELOPMENT/…/Page|Title]]`), never `obsidian://` URLs.
- A complement appends a new `##` section (or bullets inside the right section) and leaves every existing line as it was.
- A new page also gets a link line in its Category page (the page whose `type: Category` lists its siblings), part of the same approval.

## Writing a page safely

For every page touched (the page, its Category, the index):

1. `sb get` it into the scratchpad as the base; for a new page, `sb ls "<exact path>"` must list nothing (else treat it as a complement).
2. Edit a copy; the copy must contain the whole base plus the addition (no line of the base removed).
3. `sb get` again right before writing; if it differs from the base, the user edited it meanwhile: redo the edit on the new content.
4. `sb put`, then `sb get` and compare with the copy.

Pages are only ever added to or appended to: renaming, moving and deleting pages stay with the user.

## `reindex`

Compare `sb ls "Brain/"` (`.md` only) with the index links. For each knowledge page missing from the index (skip navigation pages: `type: Domain`, `Map`, `Category`; skip personal notes outside development), read it and propose its index line under a theme. Same approval and safe-write rules; then update the index.

## `audit`

A one-off look at the whole Brain with `/graphify`: copy every `Brain/` page into a new scratchpad folder (`sb get` each), run `/graphify` on that folder, and report clusters, orphan pages, duplicates and gaps against the index. Read-only: any fix it suggests goes through the harvest approval.
