# Confidence Scoring Details

This document will outline the logic for calculating the confidence score of potential Linear issue matches.

## Initial Approach (v1)

- Score based on the relevance score returned by the Linear API search (if available).
- Alternatively, use simple text similarity metrics (e.g., Jaccard index, TF-IDF cosine similarity) between the thread content and the issue title/description.
- Define thresholds for High (>0.9), Medium (0.6-0.89), and Low (<0.6) confidence.

## Potential Refinements (v2+)

- Incorporate multiple factors into the score (text similarity, author match, recency, project/team context).
- Use a weighted average or a simple machine learning model (e.g., logistic regression) trained on manually labeled examples.
- Adjust thresholds based on feedback and performance.
