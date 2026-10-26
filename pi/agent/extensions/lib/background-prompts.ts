export const backgroundLifecycleGuidelines = [
  "After spawning a task, continue independent work. When only background work remains, yield by ending your turn with a brief progress update. Completion and check-in notifications automatically resume you without a user reply. Inspect tasks only to handle a check-in or diagnose a concrete failure.",
  "While background work is active, report progress rather than claiming a final result. After it finishes, handle its result and return to the conversation's pending work. If the user was waiting to answer a question or make a decision, reconsider it in light of the result and restate the question. If no user input is pending and all background work is complete, provide a standalone final result.",
]

export const backgroundCompletionGuidance = "Review the result and continue the conversation's pending work."
