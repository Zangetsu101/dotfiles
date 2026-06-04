---
name: implement
description: Implement a plan/spec/design while maintaining a running implementation-notes.html that captures design decisions, deviations, tradeoffs, and open questions. Use when user says implement/build/execute/write/code up/carry out/follow paired with an artifact (spec, plan, design, doc, requirements, PRD, RFC).
---

Implement the plan/spec provided in the args (or ask for it if not provided).

As you work, maintain a running `implementation-notes.html` file in the project root. Update it after each meaningful implementation decision — not just at the end.

The file must be valid, readable HTML with four sections:

**Design Decisions** — choices you made where the spec was ambiguous. For each: what you decided, what the ambiguity was, and why you chose this interpretation.

**Deviations** — places where you intentionally departed from the spec. For each: what the spec said, what you did instead, and why.

**Tradeoffs** — alternatives you considered and rejected. For each: the option, why it was viable, and why you picked something else.

**Open Questions** — anything you want the user to confirm or revise before treating the implementation as final. Flag these even if you made a reasonable assumption — the user should have a chance to redirect.

Rules:

- Update the file progressively as decisions happen, not all at once at the end.
- If a decision is obvious or fully spec'd, skip it — only document what a future reader would find surprising.
- Prefer short, scannable entries over thorough prose.
- Never fabricate issues. Only log real divergences and real choices.
- When done, tell the user to check `implementation-notes.html` for anything needing review.
