# Ticket brief spec

The fields of a brief, and the rules for its pictures. The types are in `shared/brief.ts`, and `node scripts/brief.ts lint` checks every limit below. **E** means the lint refuses the save; **W** means it warns.

Text fields take `` `code` `` and `**bold**`. No other markup, no HTML: the renderer escapes everything. Links must be `http(s)`.

## Top level

| Field | Type | Limits and meaning |
|---|---|---|
| `schema` | `"ticket-brief/1"` | E: required. This is how agent-dash knows the body is a brief |
| `key` | string | The ticket key, such as `FSDK-2073`. `save` refuses a key that is not the document's ticket |
| `title` | string | What the ticket does. W: over 90 characters |
| `size` | `S` \| `M` \| `L` | Sets the word budget (900 / 1300 / 1600 visible words, W) and which sections belong (GUIDE.md, Sizing) |
| `ask` | string | One sentence: `<verb> <thing> so that <why>`. W: more than one sentence |
| `verified_on` | `YYYY-MM-DD` | The day you last checked the facts. W: older than 7 days |
| `links` | `{label, url}[]` | The ticket, sibling tickets, the main PR. Shown under the ask |
| `glance` | object | Below. W: missing |
| `system` | object | The system map. W: no `system` and no `flow` |
| `flow` | object | A sequence, for a bug or a request path |
| `done` | object | E: at least one item |
| `path` | object | The steps, in order |
| `decisions` | object | The matrices |
| `people` | object | Whose experience changes |
| `work` | object | W: missing |
| `risks` | object | Risks and open questions |
| `facts` | `Fact[]` | E: at least one. The evidence ledger |
| `glossary` | `{term, means}[]` | Jargon, in the collapsed ledger |

"Visible words" are the words a reader sees without opening anything: the ledger, the glossary, the smaller calls and the risks after the third do not count.

## Facts

`{ id, text, source, how, as_of? }`. `id` is short and unique (`f1`), E on a repeat. `how` is `verified`, `read`, `said` or `inferred`. `source` is where a reader can check it: a repo path at a commit, a command, a PR, a ticket comment, "said in #channel on date". Each field that cites a fact (`fact`, `facts`) shows its badge, with the fact in a tooltip. E: a citation to an id that is not in `facts`. W: a fact that tells the investigation ("I tested…").

## glance

| Field | Limits |
|---|---|
| `shifts` | `{what, before, after}[]`, 2–6 rows (E). `what` is the dimension (where it runs, who calls it); `before` is today; `after` is when done |
| `numbers` | `{value, label, fact?}[]`, at most 3 (E). `value` is short: `390k`, `59%`, `10-17` (W over 9 characters). W: a number with no fact |
| `headsups` | `{title, body, ticket_says?, facts?}[]`, at most 4 (E). `title` is a claim. `ticket_says` is what the ticket or AC says, shown struck through; `body` is the reality and what to do. W: no facts; W: only inferred facts and no "unverified" in the body; W: an M or L brief with none |

## system: one map, several views

| Field | Limits |
|---|---|
| `heading` | E: required. A claim |
| `nodes` | `{id, label, sub?, col, row, kind?}[]`. `col` 0–4 and `row` 0–4 (E), whole numbers. `label` ≤ 22 characters (W); `sub` ≤ 46 (W), drawn as two short lines. `kind`: `actor` (a pill), `service` (default), `store` (a cylinder), `external` (dashed) |
| `views` | 1–4 (E; W for 1). Each `{id, label, caption?, hide?, changed?, notes?, edges, pins?}` |

A view:

- `hide`: the boxes that are not there in this view. The renderer works out the rest from the view before: a box that it hid shows **NEW** (green), a box that it showed and this view hides shows once more, faded, as **REMOVED**. `changed` marks a box **CHANGED** (amber). `notes` replaces a box's `sub` in this view only (`"lambda": "proxy mode: FDR_ORIGIN set"`).
- `edges`: `{from, to, label?, tone?}`. `tone`: `normal`, `bad` (red: what is broken), `new` (green: the new path), `dashed`. E: an end that is hidden. W: a label over 26 characters; W: a label that covers a box; W: a line that crosses a box and no curve can miss it; W: a visible box with no edge.
- `pins`: `{node, text, fact?}[]`, at most 3 (E). Numbered red dots on the box, with the text listed under the map. W: the first view has none.
- E: more than 8 visible boxes in one view; two visible boxes in one cell.

### Lay out a map

- Draw the boundary that the ticket changes, not the whole platform. A box the ticket does not touch is noise.
- Callers on the left (`col 0`), what they call to the right, stores and outside services on the far right or below. Keep the request direction left to right.
- Put the new path and the old path in different rows, so that a reader sees them side by side in the "During" view.
- A box that is replaced by another stays in the same cell only when it keeps its role (mark it `changed`). A new service gets its own cell.
- The gap between two columns is narrow. A labelled edge between neighbours needs a label of about 9 characters; leave a free column, or put the label on a vertical or diagonal edge. Do not label what the box names already.
- Three views is the usual count: **Today** (problems pinned), **During** (the bridge, when there is one), **Done**. An S brief has two.

## flow

`{heading, lanes: {id, label}[], steps: {from, to, label, tone?, note?}[]}`. 2–6 lanes (E), 1–12 steps (E). `from` = `to` draws a self-call. Mark the failing or suspect step with `tone: "bad"` and a `note` (W when no step is marked). Lane labels ≤ 20 characters, step labels ≤ 40 (W).

## done

`{heading?, items: {text, verify, fact?}[], ac_review?}`. 1–8 items (E). Each `text` is an observable end state; each `verify` is a command, a test or a dashboard (E: missing). `ac_review`: `{ac, verdict, note?}[]`, with `verdict` = `ok`, `change`, `drop` or `add`; E: a non-ok verdict with no `note` saying what to write instead.

## path

`{heading?, steps: {title, who, detail?, date?, gate?, undo?, human?, state?}[]}`. At most 7 steps (E). `human: true` shows "only a human". `state`: `done`, `now`, `next`. W: no step has a gate or an undo.

## decisions

`{heading?, major: Decision[], minor?: {question, call, decider?}[]}`. At most 3 major (E); `minor` is collapsed.

A `Decision` is `{question, decider, criteria, options, why, facts?}`:

- `decider`: a person's name. E: empty, "TBD", "team".
- `criteria`: 2–5 (E). Each one says what differs between the options ("Old CLIs keep their auth"), not a category. W: a one-word category such as "cost"; W: a criterion that scores the same for every option.
- `options`: 2–4 (E), each `{name, cells, recommended?}`. One cell per criterion (E), and each cell starts with `+ ` (good), `~ ` (mixed) or `- ` (bad), then a few words (E). Exactly one option is `recommended` (E).
- `why`: one or two sentences on why the recommendation wins.

## people

`{heading?, rows: {who, before, after}[]}`, at most 5 (E). W: a row that is a user story.

## work

`{heading?, first_move, repos}`. `first_move` (E) is the one thing to do first. `repos`: at most 6 (E), each `{repo, url?, why, paths, pr?, who, human_only?}`. `who`: `agent`, `human`, `either`. `pr`: `{label, url, state}` with `state` = `draft`, `open`, `merged`, `closed`. `human_only` says what an agent must not do here (merge, prod write). A repo card can also be a cloud account. W: no paths; W: an M or L brief where nothing is marked for a human.

## risks

`{heading?, items: {text, mitigation?, fact?}[], questions?: {q, owner}[]}`. Rank the items: the first 3 show, the rest collapse. Each question has an owner (E).
