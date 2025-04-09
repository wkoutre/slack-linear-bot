# Search Algorithm Details

This document will detail the specifics of the Linear issue search algorithm.

## Initial Approach (v1)

- Extract keywords from the Slack thread's first message.
- Use Linear's `searchIssues` GraphQL endpoint with the extracted keywords.
- Consider basic filtering (e.g., status != closed).

## Potential Refinements (v2+)

- Explore semantic similarity using embeddings (e.g., using a sentence transformer model).
- Factor in thread author, mentioned users, or channel context.
- Weight recent issues higher.
