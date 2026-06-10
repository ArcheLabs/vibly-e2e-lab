# Literature Index

## Status

No structured literature index exists yet.

This is a high-priority missing asset. Before agents attempt broad theoretical work, the project needs a reviewable literature structure that records sources, results, methods, limitations, and relevance.

## Required Entry Schema

Each literature entry should use the following schema:

```md
### Entry ID

- Title:
- Authors:
- Year:
- Area:
- Claim Level:
- Main Result:
- Relevance:
- Method:
- Limitations:
- Related Entries:
- Tags:
- Summary:
- Review Notes:
```

## Claim Level

Literature entries must classify the claim level of the source summary.

Use:

```text
Level 1: Sourced summary
Level 2: Heuristic or model
Level 3: Conjecture or proposed route
Level 4: Proof sketch or partial argument
Level 5: Verified result in the source
```

A literature entry may summarize a verified result from a source, but it must not extend the result beyond what the source states.

## Priority Areas

Initial literature-index tasks should prioritize:

1. survey material for Goldbach-type problems;
2. known partial results;
3. sieve-method limitations;
4. computational verification references;
5. analytic number theory approaches;
6. heuristic models;
7. known failed or blocked routes.

## Acceptance Criteria

A literature entry is acceptable when it:

- identifies a specific source;
- states the source's result carefully;
- distinguishes result, method, and relevance;
- records limitations;
- includes tags;
- does not invent bibliographic details;
- marks uncertainty as `needs verification` when appropriate.

## Example Entry Template

```md
### LIT-000

- Title:
- Authors:
- Year:
- Area:
- Claim Level:
- Main Result:
- Relevance:
- Method:
- Limitations:
- Related Entries:
- Tags:
- Summary:
- Review Notes:
```

## Rules

Agents must not create fake citations.

If a source is known only indirectly, mark the entry as:

```text
needs verification
```

If the agent has not checked the source, it must not write as though the source has been read.
