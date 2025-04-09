# Slack-Linear Bot: Project Plan

This document outlines the plan for building the Slack-Linear integration bot, following the custom approach recommended in `initial-thread.md`.

## Phases and Steps

**Phase 1: Setup & Basic Integration**

1.1. **Configure Linear Native Integration:** Set up Linear's built-in Slack integration for basic functionalities like manual issue creation and comment syncing.
1.2. **Slack Bot Project Setup:** Initialize a new Slack bot project using the Bolt framework (TypeScript).
1.3. **API Credentials:** Securely obtain and configure Slack Bot Token and Linear API Key.
1.4. **Slack Event Subscription:** Configure the bot to listen to message events in the target `#feedback-apps` channel, specifically focusing on new threads and replies.

**Phase 2: Core Matching Logic**

2.1. **Linear API Client:** Set up a GraphQL client to interact with the Linear API.
2.2. **Initial Search Implementation:** Develop the initial logic to search Linear issues based on keywords or content extracted from the Slack thread's first message.
2.3. **Confidence Scoring (v1):** Implement a basic confidence scoring mechanism (e.g., based on keyword overlap or simple text similarity) to rank potential matches.

**Phase 3: User Interaction & Linking**

3.1. **Interactive Message Design:** Design Slack Block Kit messages to present potential matches (High, Medium confidence) or prompt for new issue creation (Low confidence).
3.2. **Handle User Actions:** Implement handlers for user interactions with the interactive messages (e.g., button clicks for confirming a match, selecting a match, triggering new issue creation).
3.3. **Basic Thread Linking:** Implement logic to associate a Slack thread with a Linear issue ID based on user confirmation. Store this link temporarily (in memory or simple storage for now).

**Phase 4: Persistence & Refinement**

4.1. **Database Setup:** Choose and set up a persistent database (e.g., PostgreSQL, Firestore) to store thread-to-issue mappings and potentially other metadata.
4.2. **Database Integration:** Implement logic to save, update, and retrieve thread-issue links from the database.
4.3. **Refine Search & Scoring:** Improve the search algorithm (e.g., incorporating semantic search concepts) and confidence scoring based on testing and feedback. Add placeholder `DETAILS/search-algorithm.md` and `DETAILS/confidence-scoring.md`.
4.4. **Error Handling & Logging:** Implement robust error handling for API calls, database operations, and event processing. Add logging.
4.5. **Syncing Enhancements:** Explore using the native integration's syncing or build custom logic to sync subsequent thread replies to the linked Linear issue.

**Phase 5: Deployment & Monitoring**

5.1. **Deployment Strategy:** Choose a deployment platform (e.g., Vercel, AWS Lambda, Google Cloud Run) and configure deployment pipelines.
5.2. **Deployment:** Deploy the bot application.
5.3. **Monitoring & Alerting:** Set up basic monitoring and alerting for bot health and errors.

**Phase 6: Advanced Features (Post-MVP)**

6.1. **AI Summarization:** Integrate AI to summarize long threads for Linear issue descriptions.
6.2. **Attachment Handling:** Add support for handling attachments from Slack threads and potentially uploading them to Linear issues.
6.3. **Configuration Options:** Allow configuration of target channels, default teams, priorities, etc., possibly via Slack commands or a simple UI.
