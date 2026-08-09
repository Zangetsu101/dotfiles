---
name: wayfinder
description: Plan a huge chunk of work - more than one agent session can hold - as a shared local map of decision tickets on the local issue tracker, then resolve them one at a time until the way to the destination is clear.
disable-model-invocation: true
---

A loose idea has arrived — too big for one agent session, and wrapped in fog: the way from here to the **destination** isn't visible yet. Wayfinding is about finding that way, not charging at the destination. This skill charts the way as a **shared map** on the repo's issue tracker, then works its **decision tickets** — questions whose resolution is a decision, not slices of a build to execute — one at a time until the route is clear.

The destination varies per effort, and naming it is the first act of charting — it shapes every ticket. It might be a spec to hand off and iterate on, a decision to lock before planning starts, or a change made in place like a data-structure migration. The map is domain-agnostic — engineering work, course content, whatever fits the shape.

## Plan, don't do

Wayfinder is **planning** by default: each ticket resolves a decision, and the map is done when the way is clear — nothing left to decide before someone goes and does the thing. The pull to just do the work is usually the signal you've reached the edge of the map and it's time to hand off. An effort can override this in its **Notes** — carrying execution into the map itself — but absent that, produce decisions, not deliverables.

## Refer by name

Every map and ticket is an issue, so it has a **name** — its title. In narration and the map's Decisions-so-far, refer to it by name. Put the stable issue identity or relative Markdown path inside the name's link so references remain exact.

## The Map

The map is `.scratch/<effort>/map.md`, the canonical artifact. Its tickets are child issues that live in the effort’s `issues/` directory.

The map is an **index**, not a store. It lists the decisions made and points at the tickets that hold their detail; a decision lives in exactly one place — its ticket — so the map only gists and links it.

Read the repository’s issue-tracker and triage-role docs. Load the `local-issue-tracker` skill for structured issue operations.

### The map body

The whole map at low resolution, loaded once per session. Open tickets are **not** listed — they are open child issues, found by query.

```markdown
## Destination

<what reaching the end of this map looks like — the spec, decision, or change this effort is finding its way to. One or two lines; every session orients to it before choosing an issue.>

## Notes

<domain; skills every session should consult; standing preferences for this effort>

## Decisions so far

<!-- the index — one line per resolved ticket: enough to judge relevance, then zoom the link for the detail the issue holds -->

- [<resolved ticket title>](link) — <one-line gist of the answer>

## Not yet specified

<!-- see "Fog of war": in-scope fog you cannot frame as a ticket yet; graduates as the frontier advances -->

## Out of scope

<!-- see "Out of scope": work ruled beyond the destination; resolved, never graduates -->
```

### Tickets

Each ticket is a local issue with a stable `<effort>/<number>` identity and this authored body, sized to one 100K token agent session:

```markdown
## Question

<the decision or investigation this ticket resolves>
```

Create it with one `Type:` value — `research`, `prototype`, `grilling`, or `task` — and triage it `ready-for-agent` for AFK work or `ready-for-human` for HITL work.

Use blocker operations for dependencies. The **frontier** is the open, unblocked tickets returned by the frontier query; use its triage filter when selecting AFK or HITL work. Claim the chosen ticket before beginning work so concurrent sessions skip it.

Author the resolution under `## Answer`, link any created assets there, then resolve the ticket.

## Ticket Types

Every ticket is either **HITL** — human in the loop, worked *with* a human who speaks for themselves — or **AFK**, driven by the agent alone. A HITL ticket only resolves through that live exchange; the agent never stands in for the human's side of it (a grilling agent that answers its own questions has broken this).

- **Research** (AFK): Reading documentation, third-party APIs, or local resources to surface a fact a decision waits on. Resolve it with a `/research` sub-agent, which creates a Markdown summary as a linked asset.
- **Prototype** (HITL): Raise the fidelity of the discussion by making a cheap, rough, concrete artifact to react to — an outline, a rough take, a stub, or UI/logic code via the /prototype skill. Links the prototype as an asset. Use when "how should it look" or "how should it behave" is the key question.
- **Grilling** (HITL): Conversation. The default case. Always invoke the `/grilling` and `/domain-modeling` skills.
- **Task** (HITL or AFK): Manual work that must happen before a *decision* can be made — nothing to decide, prototype, or research, but the discussion is blocked until it's done. Signing up for a service so its API can be judged, provisioning access, moving data so its shape can be seen. This is the one type that *does* rather than decides — and it earns its place by unblocking a decision, not by delivering the destination. The agent drives it alone where it can (AFK); otherwise it hands the human a precise checklist (HITL). Resolved when the work is done; the answer records what was done and any resulting facts (credentials location, new URLs, row counts) later tickets depend on.

## Fog of war

The map is _deliberately_ incomplete: don't chart what you can't yet see. Beyond the live tickets lies the **fog of war** — the dim view of decisions and investigations you can tell are coming but can't yet pin down, because they hang on questions still open. Resolving a ticket clears the fog ahead of it, graduating whatever's now specifiable into fresh tickets — one at a time, until the way to the destination is clear and no tickets remain.

The map's **Not yet specified** section is where that dim view is written down: the suspected question, the area to revisit later. It's the undiscovered frontier _toward_ the destination — everything here is in scope, just not sharp enough to ticket. Write as loosely or as fully as the view allows; it doubles as a signpost for collaborators reading where the effort is headed.

**Fog or ticket?** The test is whether you can state the question precisely now — _not_ whether you can answer it now.

- **Ticket when** the question is already sharp — even if it's blocked and you can't act on it yet.
- **Not yet specified when** you can't yet phrase it that sharply. Don't pre-slice the fog into ticket-sized pieces: it's coarser than a ticket, and one patch may graduate into several tickets, or none, once the frontier reaches it.

**Not yet specified** excludes what's already decided (Decisions so far), what's already a live ticket, and what's out of scope (the next section).

## Out of scope

Fog only ever gathers _toward_ the destination. The destination fixes the scope, so work beyond it is **out of scope** — it isn't fog, and it doesn't belong in **Not yet specified**. It gets its own **Out of scope** section on the map: work you've consciously ruled out of _this_ effort. Scope, not sharpness, lands it here.

Out-of-scope work never graduates — the frontier stops at the destination — so it returns only if the destination is redrawn, and then as a fresh effort, not a resumption.

Ruling something out of scope is a scoping act, not a step on the route. When an existing ticket turns out to sit past the destination, set its triage to `wontfix`, author an answer recording the scope rationale, resolve it, and add one linked gist to **Out of scope**. Keep it outside **Decisions so far**, which records the route actually walked.

## Invocation

Two modes. Either way, **never resolve more than one ticket per session** — with the exception of research tickets.

### Chart the map

User invokes with a loose idea.

1. **Name the destination.** Run a `/grilling` and `/domain-modeling` session to pin down what this map is finding its way to — the spec, decision, or change. The destination fixes the scope, so it's settled first.
2. **Map the frontier.** Grill again, **breadth-first** this time: fan out across the whole space rather than deep on any one thread, surfacing the open decisions and the first steps takeable now. **If this surfaces no fog** — the way to the destination is already clear, the whole journey small enough for one session — you don't need a map. Stop and ask the user how they'd like to proceed.
3. **Create the map** at `.scratch/<effort>/map.md`: Destination and Notes filled in, Decisions-so-far empty, and the fog sketched into **Not yet specified**.
4. **Create the tickets you can specify now**, then wire blocking edges after every issue has an identity. Everything you can't yet specify stays in the fog — the **Not yet specified** section.
5. **Fire the research sub-agents.** For each unblocked research ticket just created, dispatch a `/research` sub-agent in parallel. Each sub-agent claims its ticket, writes the linked research artifact, authors `## Answer`, and resolves the issue through the local issue tracker.
6. Stop — charting hand-resolves no tickets.

### Work through the map

User invokes with an effort or map path. A ticket is **optional** — without one, you pick the next decision, not the user.

1. Load the **map** as the low-resolution view.
2. Choose the ticket. Use a user-named ticket when provided; otherwise query the frontier and take the first ticket in order. Apply a triage filter when the invocation specifically requests AFK or HITL work. **Claim it**: assign it to yourself before any work.
3. Resolve it — **zoom as needed**: read related ticket bodies on demand and invoke the skills named in `## Notes`. Use `/grilling` and `/domain-modeling` for unresolved human decisions.
4. Record the resolution: author `## Answer`, **resolve** the issue, and append a context pointer to the map's Decisions-so-far.
5. Create newly surfaced tickets and wire their blockers after creation. Graduate newly specifiable fog into those tickets and clear it from **Not yet specified**. Move work beyond the destination to **Out of scope** using the scope-resolution procedure above. Update tickets invalidated by the decision while they remain open.

The user may run unblocked tickets in parallel, so expect other sessions to be editing the tracker concurrently.
