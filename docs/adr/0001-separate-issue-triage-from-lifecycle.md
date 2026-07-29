# Separate issue triage from lifecycle

Local Markdown issues record a required triage role independently from their lifecycle state. A unified `Status:` field made actor readiness (`ready-for-agent`, `needs-info`, and related roles) mutually exclusive with execution progress (`open`, `claimed`, and `resolved`), so frontier queries and durable claims could not represent both facts at once; accepting a schema migration now avoids preserving that ambiguity in the issue-tracker CLI.
