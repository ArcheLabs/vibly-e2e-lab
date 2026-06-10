# Failed Path Archive

## Purpose

The failed-path archive preserves useful negative information.

Mathematical research often advances by learning why plausible routes fail. Agents should not discard failed work automatically. A failed route can be a durable asset when it prevents future duplication or exposes an obstruction.

## Why Failures Matter

Failures can:

- reveal hidden assumptions;
- identify known barriers;
- clarify the limits of a method;
- show that a task was too broad;
- expose missing literature;
- suggest a better intermediate question;
- prevent repeated attempts by future agents.

A failure is not valuable merely because it failed. It is valuable when it is intelligible and reusable.

## Entry Schema

Use this schema:

```md
### Failure Entry ID

- Attempted Claim:
- Route:
- Key Assumptions:
- Failure Point:
- Obstruction:
- Evidence:
- Reusable Insight:
- Future Retry Condition:
- Related Work:
- Tags:
```

## Failure Categories

```text
F1 Unsupported assumption
F2 Circular reasoning
F3 Insufficient bound
F4 Heuristic-only gap
F5 Computational-only gap
F6 Known obstruction
F7 Missing literature
F8 Scope too broad
F9 Definition mismatch
F10 Reviewability failure
```

## Review Rules

A failure entry should be reviewed for:

- clarity of attempted route;
- accuracy of the failure point;
- usefulness of the obstruction;
- relation to existing knowledge;
- whether the failure is actually a partial success;
- whether the route should be retried under different assumptions.

## Promotion to Knowledge

Promote a failed attempt to knowledge when it:

- is clearly structured;
- identifies a reusable obstruction;
- prevents repeated work;
- states its limitations;
- includes tags;
- recommends what to do next.

Do not promote failed attempts that are only vague statements of frustration or incomplete logs without analysis.
