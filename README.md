# Slack Linear Bot

This project is a Slack bot designed to integrate with Linear for issue tracking. It listens for messages in channels it's invited to or direct messages, interprets them as search queries for Linear issues, and responds with the findings.

## Setup

1. **Clone the repository (if applicable):**

    ```bash
    git clone <repository-url>
    cd slack-linear-bot
    ```

2. **Install dependencies:**
    Make sure you have Node.js and npm installed.

    ```bash
    npm install
    ```

3. **Configure Environment Variables:**
    Create a `.env` file in the root directory of the project. Add the following environment variables with your credentials:

    ```env
    # Slack App Credentials
    SLACK_BOT_TOKEN=xoxb-...
    SLACK_SIGNING_SECRET=...
    SLACK_APP_TOKEN=xapp-...

    # Linear API Key
    LINEAR_API_KEY=lin_api_...

    # Smithery API Key (not required if using local MCP)
    SMITHERY_API_KEY=smy_...

    # Local MCP Configuration (optional)
    # Set to "true" to use local MCP instead of Smithery
    USE_LOCAL_MCP=true
    # Override the default local MCP URL if needed
    LOCAL_MCP_URL=ws://localhost:3000/mcp
    ```

    * `SLACK_BOT_TOKEN`: Your Slack bot token (starts with `xoxb-`).
    * `SLACK_SIGNING_SECRET`: Your Slack app's signing secret.
    * `SLACK_APP_TOKEN`: Your Slack app-level token for Socket Mode (starts with `xapp-`).
    * `LINEAR_API_KEY`: Your Linear API key for authentication.
    * `SMITHERY_API_KEY`: Your Smithery API key (only required when not using local MCP).
    * `USE_LOCAL_MCP`: Set to "true" to connect directly to a local Linear MCP server.
    * `LOCAL_MCP_URL`: The WebSocket URL of your local MCP server (defaults to ws://localhost:3000/mcp).

    You can find the Slack values in your Slack app's configuration page under "OAuth & Permissions" and "Basic Information". Ensure your bot has the necessary scopes (like `app_mentions:read`, `chat:write`, `channels:history`, `groups:history`, `im:history`, `mpim:history`) and is configured to use Socket Mode.

## Running the Bot

There are two main ways to run the bot:

1. **Development Mode (using `ts-node` for automatic reloading):**
    This command uses `ts-node` to run the TypeScript source directly and will restart automatically on file changes. Ideal for development.

    ```bash
    npm run dev
    ```

2. **Production Mode (compile and run JavaScript):**
    First, compile the TypeScript code to JavaScript:

    ```bash
    npm run build
    ```

    Then, run the compiled code:

    ```bash
    npm run start
    ```

Once the bot is running, it will connect to Slack using Socket Mode and print "⚡️ Bolt app is running using Socket Mode!".

## MCP Configuration

The bot can connect to Linear through either:

1. **Smithery** (default): Uses Smithery as a middleware to connect to Linear's MCP server.
2. **Direct Local MCP**: Connects directly to a locally-running Linear MCP server.

To use a local MCP server:

1. Make sure your local Linear MCP server is running (typically at ws://localhost:3000/mcp)
2. Set `USE_LOCAL_MCP=true` in your `.env` file
3. You don't need to provide a `SMITHERY_API_KEY` when using local MCP

## Usage

1. Invite the bot to a Slack channel or send it a direct message.
2. Send a message containing the text you want to search for in your Linear issues.
3. The bot will acknowledge the message and then respond in a thread with the search results found in Linear.
