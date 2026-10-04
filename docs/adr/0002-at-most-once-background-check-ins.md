---
status: accepted
---

# Deliver background task check-ins at most once

Background agents and monitors receive one check-in deadline per scheduling request. The spawning Pi receives a check-in only if the task is still running; it can schedule another explicitly. We claim each deadline on disk before sending the notification so a resumed Pi does not deliver the same check-in twice. Completion takes precedence, and a suppressed check-in can be retried when no completion record exists and the task is still running.

This favors at-most-once delivery over guaranteed delivery. A process crash after the claim but before the notification can lose that check-in. Retrying every unacknowledged claim could instead duplicate a notification sent just before a crash. Guaranteeing both would require delivery and acknowledgement to share a transaction or an idempotent receiver; neither exists here. Task completion notifications are separate from these advisory check-ins.
