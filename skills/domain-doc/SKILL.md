---
name: domain-doc
description: Write or convert an agent-dash document in the domain-driven-design (DDD) style, where every domain noun is marked by kind (stored record, code method, data object, rule, service, bounded context, external system), each mark shows a hover card from a registry in the document, each section shows its bounded context as a colored rail, and the page opens with a generated legend and a context map. Use when the user says "write this as a DDD doc", "domain-driven doc", "make the domain legible", "color-code the nouns", "add a domain legend", "mark up this doc with contexts and services", "explain this system to a newcomer", or asks for a research or architecture document in agent-dash that names tables, types, functions and services. Read-only research; it writes only the agent-dash document.
---

# domain-doc

A domain doc teaches a newcomer a part of the system by inspection. The reader sees what kind of thing each noun is (by its color and glyph), where it lives (service › store), which bounded context it belongs to (the rail and the chip), and whether it is the source of truth or a copy (a dashed border). A hover card gives the rest.

agent-dash renders this. Other markdown viewers show the marks as plain code, so the source stays readable.

Example: the registry below comes from a domain doc on docs-site RBAC. If your dashboard already has a domain doc, read it before your first doc (the `teamGuide` file in the agent-dash settings can name one):
`node ~/02_programming/agent-dash/scripts/document.ts show --id N`

## The marks

Write a mark as an inline code span with a prefix. Every name must be in the registry (below).

| Mark | Kind | Use it for | Example |
|---|---|---|---|
| `` `rec:Table.column` `` | Stored record (blue ▦) | A table, column, KV key, Edge Config item, or file in a bucket. The page shows `service›store` in front of it | `` `rec:UserRolesPerResource.role` `` |
| `` `fn:name` `` | Code method (amber ƒ) | A function, server action, route handler, or a component that does a check | `` `fn:matchRoles` ``, `` `fn:site-auth/set` `` |
| `` `obj:Type.field` `` | Data object (teal {}) | A type, schema, token, cookie, config entry, or a file shape. Not a stored row | `` `obj:SiteUser.email` `` |
| `` `rule:R1` `` | Rule (rose ⚖) | An invariant. Give each rule an ID and a short name. Mark it where a sentence relies on it | `` `rule:R5` `` |
| `` `svc:id` `` | Service (⬡) | A deployable unit, or a build job, that owns its stores. Shows the service's name | `` `svc:worker` `` |
| `` `ctx:id` `` | Bounded context (◧ chip) | Put one in a heading to give that section a rail. Use it inline when a word is in more than one context | `` ## 2a. Pages `ctx:viewer` `` |
| `` `ext:Name` `` | External system or actor (gray, dotted) | A person, or a system that is not ours | `` `ext:Auth0` ``, `` `ext:Reader` `` |

Modifiers come from the registry, not the mark: `copyOf` draws a dashed border (a copy can be late or wrong), and `key: true` adds 🔑 (an identity key that joins records across contexts).

A mark like `` `rec:Table.column` `` finds the entry `Table.column`, or else `Table`. So register each table once, and register a column on its own only when it needs its own card (for example, a key).

Keep these as **plain code**: file paths, literal values (`admin`, `"anonymous"`), markup (`<If roles>`), and config keys that are not domain nouns.

## The registry

Put one ```` ```domain ```` fence near the top, under a `## Legend` heading. It holds one JSON object. agent-dash renders it as the legend: the kinds, the contexts, the services with their stores, and the rules. The order of `contexts` sets their colors: violet, olive, sienna, slate, plum, moss.

```json
{
  "contexts": {
    "viewer": { "name": "Docs-viewer RBAC", "about": "One or two sentences: what this context decides." }
  },
  "services": {
    "registry": { "name": "Docs Registry", "about": "What it is, and what it does here.", "stores": { "pg": "Registry Postgres (docs ledger)" } }
  },
  "terms": {
    "docs_ledger_segment_details": { "kind": "rec", "service": "registry", "store": "pg", "context": "viewer", "about": "…", "code": "servers/registry/prisma/schema.prisma:733" },
    "RbacManifest": { "kind": "rec", "service": "astro", "store": "r2", "context": "viewer", "copyOf": "NavigationNode.viewers", "sync": "How it follows the source, and how late it can be.", "about": "…" },
    "SiteUser.email": { "kind": "obj", "context": "siteauth", "key": true, "about": "…" },
    "matchRoles": { "kind": "fn", "context": "viewer", "about": "…", "code": "path:line" },
    "Auth0": { "kind": "ext", "context": "member", "about": "…" },
    "R1": { "kind": "rule", "name": "A child narrows its parent", "context": "viewer", "about": "The full rule." }
  }
}
```

- `kind` is `rec`, `fn`, `obj`, `rule` or `ext`. Services and contexts have their own maps.
- A `rec` needs `service` and `store`. The store must be a key of that service's `stores`.
- The owner of a store is the service that **writes** it. A store that many services read still has one owner.
- `about` is the card's body. Write what a newcomer needs, in one to three short sentences. It can use inline markdown.
- `code` is `path:line` at the commit that the doc names.

## How to classify a noun

| The noun is… | Mark |
|---|---|
| A Postgres table or column | `rec`, `store` = that service's Postgres |
| A KV key, an Edge Config item, a file in a bucket | `rec`, with that store |
| A derived copy (a mirror, a manifest, a search index field, a cache) | its kind, plus `copyOf` and `sync` |
| A TypeScript type, zod schema, JSON shape, cookie or token | `obj` |
| An object held by a third party (an Auth0 member) | `obj`, and say in `about` where it lives |
| A third-party system, or a kind of person | `ext` |
| A build job (it runs, writes, and stops) | `svc`, and say "a build job" in `about`. What it writes is as old as its last run |
| Shared library code that no single service owns | `fn` or `obj` with no `service`. Say in `about` which services call it |
| A field that joins two contexts (email, user ID, org ID) | `key: true` |

## Workflow

1. **Pin the code.** Name the repo, branch and commit in the first line. Read the code at that commit. Run `git grep` for every name before you register it. Use the name that the code uses.
2. **Find the bounded contexts first.** Look for a word that means two things (for example, "role"). Each meaning is a context. Two to four contexts is normal. Write each one as one sentence.
3. **List the services and their stores.** Include the build jobs and the CLI. For each store, find the one writer.
4. **Find the rules.** An invariant that the code enforces, and that a change could break, is a rule. Give each one an ID (R1, R2…) and a name of five words or fewer.
5. **Find the copies and the keys.** For each copy: what is its source, what syncs it, and how late can it be? For each context pair: which key joins them, and where is it missing?
6. **Write the page in this order:**
   1. Title, then one line: the ticket, the repo, and the commit.
   2. `## Legend`: one sentence ("hover over a mark for its card"), then the ```` ```domain ```` fence.
   3. `## TL;DR`: five or six numbered findings, with marks.
   4. `## 0. Context map`: a `flowchart TB`, with one `subgraph` for each context, `ext` nodes outside the subgraphs, and an arrow for each way that one context affects another. Label each arrow with what crosses it. Draw a dotted arrow for a link that does not exist yet. Then a **"Where each context runs"** table: one row for each service, one column for each context.
   5. One section for each context, with `` `ctx:id` `` at the end of its heading. Put the data model (an ER diagram plus a Term / Store / Writer / Readers table) and the rules of that context in it.
   6. Flows: one `sequenceDiagram` for each important path. Use registry names in the arrows. Put `ctx:` in the heading of a flow that stays in one context. For a flow that crosses contexts, say in one line where the hand-off is.
   7. How the contexts meet: what the upstream context gives the downstream one, and how each variant fills it.
   8. Facts that shape the next step, each with "→ what it means".
   9. Not checked: what you did not verify.
7. **Mark every mention** of a registered noun in prose and tables, not only the first. Do not put marks in fences: Mermaid shows them as text.
8. **Lint until it is clean:**
   `node ~/02_programming/agent-dash/scripts/document.ts lint --file <file>`
   It reports a mark that is not in the registry, a kind that differs from the registry, a registered name in plain code with no mark, a term that is never marked, a context that no heading names, and a bad service or store. Fix every error and every warning.
9. **Save:** `node ~/02_programming/agent-dash/scripts/document.ts create --ticket KEY --title "…" --file <file>`, or `save --id N --file <file>` to replace a document.
10. **Look at it**, if you have `agent-browser`: open `http://127.0.0.1:7777/#/doc:N`, check that no diagram says "does not render", and hover over one mark of each kind.

Write every line in ASD-STE100: short sentences, one idea in each, active voice, one term for one thing. The registry is where "one term for one thing" is enforced.

## Mermaid styles

Use the same colors as the marks. In an ER diagram, give the classes with `class` lines at the end. `:::class` on an aliased entity (`ID["name"]:::rec`) in a relationship does not parse.

```
classDef rec fill:#3b82c433,stroke:#3b82c4,stroke-width:2px
classDef recCopy fill:#3b82c41a,stroke:#3b82c4,stroke-width:2px,stroke-dasharray:6 4
classDef obj fill:#14a39033,stroke:#14a390,stroke-width:2px
classDef objCopy fill:#14a3901a,stroke:#14a390,stroke-width:2px,stroke-dasharray:6 4
classDef ext fill:#8881,stroke:#888,stroke-dasharray:2 3
class docs_ledger_segments,docs_ledger_artifacts rec
```

A name with a dot or a space needs an alias: `TENANTS_AUTH["TENANTS.auth"] { … }`.

For the context map, color each `subgraph` in its context's order: violet `#6d4bd8`, olive `#5c7a1f`, sienna `#9a4a1c`, slate `#4b5f7a`, plum `#8e3b8e`, moss `#2f7a52`:
`style VR fill:#6d4bd81a,stroke:#6d4bd8,stroke-width:2px`

Use `flowchart TB` for the context map. `LR` with three or more subgraphs renders too small to read.

## Gotchas

- The `read` tool keeps an image by its path. Give each screenshot a new file name, or you see an old one.
- `about` text is not linted. A mark inside `about` renders, but nothing checks it.
- The whole fence must be valid JSON. One trailing comma turns the legend into an error box.
