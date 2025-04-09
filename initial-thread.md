<img src="https://r2cdn.perplexity.ai/pplx-full-logo-primary-dark%402x.png" class="logo" width="120"/>

# Slack to Linear Integration: Decision Tree and Implementation Options

Based on your MVP requirements, you need a Slack bot that monitors thread activity in a \#feedback-apps channel and connects these threads with Linear tickets. Here's a refined approach to your project:

## Decision Tree Logic

### Thread Event Detection

- **On New Thread Creation**
  - Capture thread content, author, timestamp, and any attachments
  - Extract key information for matching (keywords, issue description)
  - Proceed to Linear ticket matching process
- **On Thread Update**
  - Determine if this is the first update or a subsequent one
  - Check if thread is already linked to a Linear ticket
  - If linked: sync new comments to the Linear ticket
  - If not linked: proceed as if it's a new thread

### Linear Ticket Matching

- **Search Criteria Definition**
  - Primary search: exact text matches or key phrases
  - Secondary search: semantic similarity using NLP
  - Tertiary search: by related components/projects mentioned
  - Consider recency of tickets (prioritize active tickets)

### Confidence Scoring

- **High Confidence Match (90%+)**
  - Automatically link thread to ticket
  - Notify thread participants of the match
  - Provide quick actions (confirm match, reject match)
- **Medium Confidence Matches (60-89%)**
  - Present top 3-5 potential matches to user
  - Allow user to select correct match or create new ticket
  - Include preview of each ticket's title and description
- **Low Confidence (<60%)**
  - Suggest creating a new ticket
  - Still offer option to search manually

### Ticket Creation Logic

- **When Creating New Ticket**
  - Extract title from first message or generate one using AI
  - Use thread content for description
  - Determine appropriate team assignment based on:
    - Channel context
    - Mentioned components/features
    - Historical patterns
  - Set default priority or infer from language
  - Attach screenshots/files from thread

### Thread Linking Behavior

- **After Successful Link**
  - Add visual indicator in thread that link is established
  - Provide ticket status and quick actions in thread
  - Set up bidirectional sync for future comments
  - Consider notification settings for thread participants

### Error Handling

- **API Failure Scenarios**
  - Queue failed operations for retry
  - Notify administrators of persistent failures
  - Provide manual fallback options
- **Permission Issues**
  - Handle cases where bot lacks necessary permissions
  - Guide users through proper authorization steps

## Implementation Options

### 1. Linear's Native Slack Integration

**Pros:**

- Official integration with built-in support
- Provides basic thread syncing functionality
- Relatively easy setup process[^1]

**Limitations:**

- Lacks automatic ticket matching capabilities
- Requires manual action to create issues from messages
- Limited customization for confidence scoring and suggestions[^5]

**Implementation:**

- Configure through Linear's Settings > Features > Integrations > Slack[^2]
- Enables creating issues from Slack messages via More actions menu
- Supports syncing comment threads bidirectionally[^1]

### 2. Custom Slack Bot with Linear API

**Pros:**

- Full control over matching logic and confidence scoring
- Can implement custom UI for presenting match options
- Ability to add specialized features beyond Linear's integration

**Implementation:**

- Use Slack's Bolt framework to build a custom bot
- Implement Linear GraphQL API calls for ticket operations
- Store thread-to-ticket mappings in a database
- Deploy on serverless infrastructure (AWS Lambda, Vercel, etc.)

### 3. Integration Platform: Zapier

**Pros:**

- No-code/low-code solution
- Supports complex conditional logic
- Handles authentication and API maintenance[^5]

**Limitations:**

- May become costly with high volume
- Limited UI customization for user interactions
- Might require premium plan for advanced features

**Implementation:**

- Create Zaps triggered by Slack events
- Configure conditional paths based on matching logic
- Use Zapier's built-in search functions or custom code steps[^5]

### 4. Integration Platform: Make (formerly Integromat)

**Pros:**

- Visual workflow builder with advanced logic capabilities
- Better pricing for high-volume operations than Zapier
- Supports custom HTTP requests for specialized API calls[^3]

**Implementation:**

- Create scenarios triggered by Slack events
- Implement Linear API calls for searching and creating tickets
- Use JSON parsing for confidence scoring logic

### 5. Specialized Tools: ClearFeed or Thena

**Pros:**

- Purpose-built for support workflows
- Includes AI-powered ticket creation and matching
- Provides additional helpdesk features[^5][^6]

**Implementation:**

- ClearFeed offers one-click and automatic issue filing
- Thena provides direct Linear integration with OAuth authentication
- Both tools include thread linking capabilities[^5][^6]

## Recommended Approach

For your MVP, I recommend starting with either:

1. **Linear's native integration + custom bot extension**: Use Linear's built-in functionality for thread syncing, but add a custom bot that enhances it with automatic matching capabilities.
2. **ClearFeed**: If you want a quick solution, ClearFeed already implements most of your requirements including automatic issue filing and AI-powered summaries.[^5]

For the custom approach, you'll need to:

1. Set up event listeners for thread creation and updates in your Slack channel
2. Implement search algorithms against Linear's API to find matching tickets
3. Create a confidence scoring system based on text similarity
4. Build interactive message components to present match options to users
5. Develop a database to track thread-ticket relationships

This approach gives you the most flexibility to refine your matching algorithm over time while leveraging existing integration capabilities.

<div>⁂</div>

[^1]: <https://linear.app/integrations/slack>

[^2]: <https://linear.app/docs/slack>

[^3]: <https://www.make.com/en/integrations/linear/slack>

[^5]: <https://clearfeed.ai/blogs/linear-slack-integration-to-enhance-collaboration>

[^6]: <https://www.thena.ai/post/linear-slack-integration>
