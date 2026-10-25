---
status: accepted
---

# Deliver background task check-ins at most once

Background agents and monitors receive one check-in deadline per scheduling request. The spawning Pi receives a check-in only if the task is still running; it can schedule another explicitly. We claim each deadline on disk before sending the notification so a resumed Pi does not deliver the same check-in twice. Completion takes precedence, and a suppressed check-in can be retried when no completion record exists and the task is still running.

This favors at-most-once delivery over guaranteed delivery, except for the bounded callback-exception retry contract below. A process crash after the claim but before the notification can lose that check-in. Retrying every unacknowledged claim could instead duplicate a notification sent just before a crash. Guaranteeing both would require delivery and acknowledgement to share a transaction or an idempotent receiver; neither exists here. Task completion notifications are separate from these advisory check-ins.

## Bounded callback-exception retries

A callback that throws or rejects permits three retries after the initial attempt, delayed by 1 second, 5 seconds, and 30 seconds from each rejection. The fourth exception logs a terminal failure and retains the claim. Returning `false` remains suppression, with a 1-second retry and no exception-budget charge; success retains the claim. Completion or a replaced deadline cancels retry delivery. Stopping a watcher cancels its wakeups, including those from callbacks still settling.

The scheduler writes the exception count and next eligible time to a per-deadline `.retry` sidecar while holding the exclusive claim, then releases the claim. Reloads and competing schedulers share that budget and cannot deliver before the persisted backoff. Explicit scheduling creates a new deadline and budget. Filesystem errors are reported, not automatically retried; a failure while holding a claim leaves it held. A crash-held claim is never reclaimed, even when retry state exists. Retry state is not a delivery acknowledgement or a crash-recovery transaction.

This deliberately relaxes strict at-most-once delivery for observed callback exceptions: a callback that sends partially or fully and then throws can cause duplicate notifications. Callbacks should reject before sending, or make delivery idempotent where possible. Exclusive claims prevent concurrent callback attempts, but cannot make external delivery and its acknowledgement atomic. A stopped or losing scheduler does not poll for another process releasing its claim; a later watch can resume released retry state. Retry sidecars remain with the task's other on-disk artifacts.
