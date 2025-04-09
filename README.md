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

    # Optional: MCP credentials if needed for direct connection
    # MCP_API_KEY=...
    # MCP_AGENT_ID=...
    ```

    * `SLACK_BOT_TOKEN`: Your Slack bot token (starts with `xoxb-`).
    * `SLACK_SIGNING_SECRET`: Your Slack app's signing secret.
    * `SLACK_APP_TOKEN`: Your Slack app-level token for Socket Mode (starts with `xapp-`).

    You can find these values in your Slack app's configuration page under "OAuth & Permissions" and "Basic Information". Ensure your bot has the necessary scopes (like `app_mentions:read`, `chat:write`, `channels:history`, `groups:history`, `im:history`, `mpim:history`) and is configured to use Socket Mode.

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

## Usage

1. Invite the bot to a Slack channel or send it a direct message.
2. Send a message containing the text you want to search for in your Linear issues.
3. The bot will acknowledge the message and then respond in a thread with the search results found in Linear.
