---
name: wayfinder
description: Plan a huge chunk of work - more than one agent session can hold - as a shared local map of investigation issues, then resolve them one at a time until the way to the destination is clear.
disable-model-invocation: true
---

A loose idea has arrived — too big for one agent session, and wrapped in fog: the way from here to the **destination** isn't visible yet. Wayfinding is about finding that way, not charging at the destination. This skill charts the way as a **shared map** on the repo's issue tracker, then works its issues one at a time until the route is clear.

The destination varies per effort, and naming it is the first act of charting — it shapes every issue. It might be a spec to hand off and iterate on, a decision to lock before planning starts, or a change made in place like a data-structure migration. The map is domain-agnostic — engineering work, course content, whatever fits the shape.

## Plan, don't do

Wayfinder is **planning** by default: each issue resolves a decision, and the map is done when the way is clear — nothing left to decide before someone goes and does the thing. The pull to just do the work is usually the signal you've reached the edge of the map and it's time to hand off. An effort can override this in its **Notes** — carrying execution into the map itself — but absent that, produce decisions, not deliverables.

## Refer by name

Every map and issue has a **name** — its title. In narration and the map's Decisions-so-far, refer to work by name. Put the stable issue identity or relative Markdown path inside the link so names remain readable while references remain exact.

## The Map

The map is `.scratch/<effort>/map.md`, the canonical artifact. Its child issues live in the effort’s `issues/` directory.

The map is an **index**, not a store. It lists the decisions made and points at the issues that hold their detail; a decision lives in exactly one issue, so the map only gists and links it.

Read the repository’s issue-tracker and triage-role docs. Load the `local-issue-tracker` skill for structured issue operations.

### The map body

The whole map at low resolution, loaded once per session. Open issues are **not** listed — they are open child issues, found by query.

```markdown
## Destination

<what reaching the end of this map looks like — the spec, decision, or change this effort is finding its way to. One or two lines; every session orients to it before choosing an issue.>

## Notes

<domain; skills every session should consult; standing preferences for this effort>

## Decisions so far

<!-- the index — one line per resolved issue: enough to judge relevance, then zoom the link for the detail the issue holds -->

- [<resolved issue title>](link) — <one-line gist of the answer>

## Not yet specified

<!-- see "Fog of war": in-scope fog you cannot frame as an issue yet; graduates as the frontier advances -->

## Out of scope

<!-- see "Out of scope": work ruled beyond the destination; resolved, never graduates -->
```

### Issues

Each map issue has a stable `<effort>/<number>` identity and this authored body, sized to one 100K token agent session:

```markdown
## Question

<the decision or investigation this issue resolves>
```

Create it through the CLI with one `Type:` value — `research`, `prototype`, `grilling`, or `task` — and triage it `ready-for-agent` for AFK work or `ready-for-human` for HITL work.

Use CLI blocker operations for dependencies. The **frontier** is the open, unblocked issues returned by the CLI frontier query; use its triage filter when selecting AFK or HITL work. Claim the chosen issue through the CLI before beginning work so concurrent sessions skip it.

Author the resolution under `## Answer`, link any created assets there, then use the CLI to resolve the issue.

## Issue Types

Every issue is either **HITL** — human in the loop, worked *with* a human who speaks for themselves — or **AFK**, driven by the agent alone. A HITL issue only resolves through that live exchange; the agent never stands in for the human's side of it (a grilling agent that answers its own questions has broken this).

- **Research** (AFK): Reading documentation, third-party APIs, or local resources like knowledge bases. Creates a markdown summary as a linked asset. Use when knowledge outside the current working directory is required.
- **Prototype** (HITL): Raise the fidelity of the discussion by making a cheap, rough, concrete artifact to react to — an outline, a rough take, a stub, or UI/logic code via the /prototype skill. Links the prototype as an asset. Use when "how should it look" or "how should it behave" is the key question.
- **Grilling** (HITL): Conversation via the /grilling and /domain-modeling skills, one question at a time. The default case.
- **Task** (HITL or AFK): Manual work that must happen before a *decision* can be made — nothing to decide, prototype, or research, but the discussion is blocked until it's done. Signing up for a service so its API can be judged, provisioning access, moving data so its shape can be seen. This is the one type that *does* rather than decides — and it earns its place by unblocking a decision, not by delivering the destination. The agent drives it alone where it can (AFK); otherwise it hands the human a precise checklist (HITL). Resolved when the work is done; the answer records what was done and any resulting facts (credentials location, new URLs, row counts) later issues depend on.

## Fog of war

The map is _deliberately_ incomplete: don't chart what you can't yet see. Beyond the live issues lies the **fog of war** — the dim view of decisions and investigations you can tell are coming but can't yet pin down, because they hang on questions still open. Resolving an issue clears the fog ahead of it, graduating whatever's now specifiable into fresh issues — one at a time, until the way to the destination is clear and no issues remain.

The map's **Not yet specified** section is where that dim view is written down: the suspected question, the area to revisit later. It's the undiscovered frontier _toward_ the destination — everything here is in scope, just not sharp enough to become an issue. Write as loosely or as fully as the view allows; it doubles as a signpost for collaborators reading where the effort is headed.

**Fog or issue?** The test is whether you can state the question precisely now — _not_ whether you can answer it now.

- **Issue when** the question is already sharp — even if it's blocked and you can't act on it yet.
- **Not yet specified when** you can't yet phrase it that sharply. Don't pre-slice the fog into issue-sized pieces: it's coarser than an issue, and one patch may graduate into several issues, or none, once the frontier reaches it.

**Not yet specified** excludes what's already decided (Decisions so far), what's already a live issue, and what's out of scope (the next section).

## Out of scope

Fog only ever gathers _toward_ the destination. The destination fixes the scope, so work beyond it is **out of scope** — it isn't fog, and it doesn't belong in **Not yet specified**. It gets its own **Out of scope** section on the map: work you've consciously ruled out of _this_ effort. Scope, not sharpness, lands it here.

Out-of-scope work never graduates — the frontier stops at the destination — so it returns only if the destination is redrawn, and then as a fresh effort, not a resumption.

Ruling something out of scope is a scoping act, not a step on the route. When an existing issue turns out to sit past the destination, set its triage to `wontfix`, author an answer recording the scope rationale, resolve it through the CLI, and add one linked gist to **Out of scope**. Keep it outside **Decisions so far**, which records the route actually walked.

## Invocation

Two modes. Either way, **never resolve more than one issue per session.**

### Chart the map

User invokes with a loose idea.

1. **Name the destination.** Run a `/grilling` and `/domain-modeling` session to pin down what this map is finding its way to — the spec, decision, or change. The destination fixes the scope, so it's settled first.
2. **Map the frontier.** Grill again, **breadth-first** this time: fan out across the whole space rather than deep on any one thread, surfacing the open decisions and the first steps takeable now. **If this surfaces no fog** — the way to the destination is already clear, the whole journey small enough for one session — you don't need a map. Stop and ask the user how they'd like to proceed.
3. **Create the map** at `.scratch/<effort>/map.md`: Destination and Notes filled in, Decisions-so-far empty, and the fog sketched into **Not yet specified**.
4. **Create the issues you can specify now** through the CLI, then wire blocking edges through CLI operations after every issue has an identity. Everything you can't yet specify stays in **Not yet specified**.
5. Stop — charting the map is one session's work; do not also resolve issues.

### Work through the map

User invokes with an effort or map path. An issue is **optional** — without one, you pick the next decision, not the user.

1. Load the **map** as the low-resolution view.
2. Choose the issue. Use a user-named issue when provided; otherwise query the CLI frontier and take the first issue in order. Apply a triage filter when the invocation specifically requests AFK or HITL work. Claim the issue through the CLI before reading further.
3. Resolve it — **zoom as needed**: read related issue bodies on demand and invoke the skills named in `## Notes`. Use `/grilling` and `/domain-modeling` for unresolved human decisions.
4. Record the resolution: author `## Answer`, resolve the issue through the CLI, and append a context pointer to the map's Decisions-so-far.
5. Create newly surfaced issues through the CLI and wire their blockers after creation. Graduate newly specifiable fog into those issues and clear it from **Not yet specified**. Move work beyond the destination to **Out of scope** using the scope-resolution procedure above. Update issues invalidated by the decision while they remain open.

The user may run unblocked issues in parallel, so expect other sessions to be editing the tracker concurrently.
