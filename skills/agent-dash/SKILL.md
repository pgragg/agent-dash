---
name: agent-dash
description: Drive agent-dash (the local dashboard of tickets, agents, PRs and smoketests at http://127.0.0.1:7777) through its agent mode, a small JSON API with the next actions on each object. Use when the user says "use agent-dash to find what I should do next", "what needs me", "look at agent-dash", "keep FSDK-123 moving", "plan and run the smoketest for X", "reply to the waiting agents", or any task that reads or acts on the dashboard. Do not read the README, grep the server, take screenshots, or read /api/dashboard (2 MB): start at GET /api/agent.
---

# agent-dash

agent-dash runs on this machine at `http://127.0.0.1:7777`. Its **agent mode** answers in small JSON. Each object has:

- `ui`: the link to the object on the page. Give it to the person when you name the object.
- `actions`: what you can do next. Each action has `method`, `href`, `body`, a `curl` line that works as printed, `effect` (`local`, `tracker` or `slack`) and `askFirst`.
- `self` or `links`: where to read more.

## Rules

1. **Start at `GET /api/agent`.** It gives the counts, the health of the sources, and every other route. Do not guess routes.
2. **Use the `curl` line of an action.** Replace each `<placeholder>`, and change nothing else. Every POST needs the header `X-Agent-Dash: 1`; the curl line has it.
3. **`askFirst: true` means: ask the person first.** Show the exact change (for example the Slack text, or the new due date), and wait for a yes. A smoketest plan's `confirm_and_run` is the person's click, unless they allowed it for that environment in their message.
4. **Long texts are cut** at about 240 characters. Add `full=1` to a GET to read them whole. `GET /api/agent/run?session=<id>` gives an agent's whole last message.
5. **Do not poll status files with `sleep`.** `GET /api/agent/wait?session=<id>&for=stop&timeout=600` returns when the agent stops (it waits for you, or it ended), with its last message.
6. **Do not use `agent-browser` on the dash** to start agents or press buttons. Every button that an agent needs is an action here.

## Routes

| Route | Gives |
|---|---|
| `GET /api/agent` | Counts (`needsYou`, `waiting`, `working`), sources, rules, links |
| `GET /api/agent/board` | The board's sections in page order: `starred`, `up_next` (ranked, what needs the person), `parked_asks`, `waiting_on_others`, `working`, `finished`, `until_change`, `done_tickets`, `snoozed`, `quiet`. Long sections list 15 entries, and `count` gives the total |
| `GET /api/agent/ticket?key=KEY` | One ticket: signals, SDLC stage, drafted next steps (each with its start action), agents with what they need, parked asks, PRs with CI and review state, smoketests, notes, and the ticket's actions |
| `GET /api/agent/run?session=ID` | One agent conversation, with its whole last message and its actions (reply, steer, stop, resume) |
| `GET /api/agent/wait?session=ID&for=stop\|finished&timeout=S` | Blocks until the agent stops or ends (at most 600 s) |
| `GET /api/transcript?session=ID` | The whole chat, without tool traffic |
| `GET /api/ticket?key=KEY` | The tracker's description, comments and transitions (the statuses for `move`) |

## Shapes

- A board section: `{id, title, hint, count, items: [...]}`. `count` can be more than `items`.
- A board entry: `{ref, title, ticket?: {key, status, priority, due, mine}, signal?: {kind, reason, status, since}, otherSignals?, needs, next?: {label, ui}, firstStep?, agents?: {waiting, working}, ui, self}`. `self` is the ticket or run route.
- A `parked_asks` entry: `{ticket, count, ui, self?, asks: [{sessionId, name, reason, parkedAt, needs}]}`. The section's `actions` have `{sessionId}` in their URL: fill it in.

## Recipes

**"What should I do next?"**

1. `curl -s 127.0.0.1:7777/api/agent/board`
2. Read `starred`, then `up_next`, in order. Each entry has `signal.reason`, `needs` (what its agent needs from the person), and `next` (where the person acts).
3. For the top 3 to 5 entries, read `self` (the ticket or run) if `needs` is not clear.
4. Answer with a numbered list. For each entry: what to do, why it is urgent, and its `ui` link. Do the actions that are `askFirst: false` and that the person asked for. Do not do others without a yes.

**"Keep KEY moving."**

1. `curl -s '127.0.0.1:7777/api/agent/ticket?key=KEY'`
2. Look at `signals`, `sdlc.next`, `nextSteps.steps` and `agents[].needs`.
3. To act, use an action: `start_step` starts an agent on a drafted step, `plan_smoketest` starts an agent that plans a smoketest (pick `env` from the list in its title), and `reply` answers a waiting agent.
4. After you start or reply to an agent, call its `wait` action. Then read `run.lastMessage`, and decide the next step.

**"Move things along."** The person's message gives the steps and the hard limits. Keep the limits, and put them in each message that you send to an agent: in `start_agent`'s `message`, in a `reply`, in a parked ask's `send`, and in a smoketest run's `note`. Use `start_agent` with your own message, not `start_step`, because a stored step message does not carry the limits.

**Close an agent whose ask is done.** Read its ask with `GET /api/agent/run?session=ID`, and note when it asked. Look for proof that the ask was done after that time, in read-only sources: Slack search (for example, the person sent the drafted message, or the approval came), the PR state, the Jira status, the ticket's notes, and git. If the proof is clear and nothing in the ask is still open, close it: `resolve` for an agent on a ticket, `dismiss` for a parked ask, `end` for a headless run with no ticket. Each one can be undone: `resume`, or `/api/threads` with `{status: "relevant"}`. Give the person the proof, for example a Slack message link. Never close an agent that is working.

**Answer a waiting agent.** Read the agent's whole message with `GET /api/agent/run?session=ID`. If you can answer it from what you know, use its `reply` action. If it asks for a decision of the person, put the question in your answer, with the agent's `ui` link.
