import Bolt, {
  SlackEventMiddlewareArgs,
  GenericMessageEvent, // Import specific message type
} from "@slack/bolt";
import dotenv from "dotenv";
import { getMcpClient, markAsDisconnected } from "./mcp_client.js"; // Import MCP client and markAsDisconnected
import {
  processMessageWithLLM,
  type McpTool,
  type LlmResponse,
} from "./llmquery.js";

dotenv.config();

const appToken = process.env.SLACK_APP_TOKEN;
if (!appToken) {
  throw new Error(
    "SLACK_APP_TOKEN environment variable is required for Socket Mode."
  );
}

// Initializes your app with your bot token and signing secret
const app = new Bolt.App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  // Socket Mode recommended for development
  socketMode: true, // Enable Socket Mode
  appToken: appToken, // Use the App-Level Token
});

// Listen to any message posted in a channel the bot is part of or DMs
app.message(async ({ message, say }: SlackEventMiddlewareArgs<"message">) => {
  // Check if it's a regular user message (not a subtype like edit/delete/join)
  if (message.subtype === undefined || message.subtype === "file_share") {
    // Cast to GenericMessageEvent for type safety
    const userMessage = message as GenericMessageEvent;

    // Ignore messages from bots or system messages without a user
    if (!userMessage.user) {
      return;
    }

    // Check if the message is from a bot
    // We need to check the raw message as the Slack Bolt types don't fully capture bot_id/bot_profile
    const rawMessage = message as any;
    if (
      rawMessage.subtype === "bot_message" ||
      rawMessage.bot_id ||
      rawMessage.bot_profile
    ) {
      console.log(
        `Ignoring message from bot with ID: ${rawMessage.bot_id || "unknown"}`
      );
      return;
    }

    const text = userMessage.text || "";
    const userId = userMessage.user;
    const channelId = userMessage.channel; // Explicitly get channel ID
    const thread_ts = userMessage.thread_ts || userMessage.ts;
    const files =
      userMessage.files
        ?.map((f) => f.url_private_download)
        .filter((url) => url !== undefined) || []; // Get files array if present

    console.log(
      `Received message from ${userId} in channel ${channelId}: "${text}" ${
        files.length > 0 ? `with ${files.length} file(s)` : ""
      }`
    );

    // Use the template response format from the requirement
    await say({
      text: "Hey, i'm your new Slack bot. I can help you manage your Linear issues:",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "Hey, i'm your new Slack bot. I can help you manage your Linear issues:",
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "Find related Linear issues",
              },
              style: "primary", // Green background
              action_id: "find_linear_issues",
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "Ignore me",
              },
              style: "danger", // Red background
              action_id: "ignore_bot",
            },
          ],
        },
      ],
      thread_ts,
    });

    // Store the message details in a state that can be accessed by the button handlers
    // This could be in memory (for development) or in a database (for production)
    // For now, we'll just log what we would store
    console.log(
      `Storing message data for future retrieval: channel=${channelId}, thread_ts=${thread_ts}, text="${text}", files=${files.length}`
    );

    // No automatic processing of the message - wait for button click instead
  }
});

// Basic error handler
app.error(async (error: Error) => {
  console.error("Bolt app error:", error);
});

// Add handlers for button interactions
app.action(
  "find_linear_issues",
  async ({ body, ack, say, context, client }) => {
    await ack();

    // Type casting based on Slack Bolt types
    type ButtonActionBody = {
      user: { id: string };
      channel: { id: string };
      message?: {
        thread_ts?: string;
        ts: string;
        text?: string;
      };
      response_url?: string;
    };

    const typedBody = body as unknown as ButtonActionBody;

    // Extract message details from the button click
    const threadTs = typedBody.message?.thread_ts || typedBody.message?.ts;
    const channelId = typedBody.channel?.id;
    const userId = typedBody.user?.id;

    // Get the original message text from the thread
    let messageText = "";
    if (typedBody.message?.thread_ts) {
      try {
        // This would require reading the original message content from the thread
        console.log("Finding related issues from thread");
        // In a complete implementation, you would fetch the thread content here
        messageText = "Extracted from thread";
      } catch (error) {
        console.error("Error fetching thread message:", error);
      }
    } else {
      // If we're not in a thread, use text from the message containing the button
      messageText = typedBody.message?.text || "";
    }

    console.log(
      `User ${userId} clicked to find Linear issues related to: "${messageText}"`
    );

    // Respond to the user - use client.chat.postMessage as a more reliable alternative to say
    if (channelId && threadTs) {
      try {
        if (say && typeof say === "function") {
          // Use say if it's available
          await say({
            text: "Searching Linear for related issues...",
            thread_ts: threadTs,
            channel: channelId,
          });
        } else {
          // Fallback to client.chat.postMessage
          await client.chat.postMessage({
            text: "Searching Linear for related issues...",
            thread_ts: threadTs,
            channel: channelId,
          });
        }
      } catch (error) {
        console.error("Error sending response:", error);
        // If both fail and we have a response_url, use that as last resort
        if (typedBody.response_url) {
          try {
            await fetch(typedBody.response_url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                text: "Searching Linear for related issues...",
                response_type: "ephemeral",
              }),
            });
          } catch (fetchError) {
            console.error("Failed to use response_url:", fetchError);
          }
        }
      }
    }

    // The rest of the search functionality would follow here
    // This would normally call the processMessageWithLLM function
    try {
      // Use a loop for potential retries on connection failure
      let success = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        // Try up to 2 times
        try {
          console.log(`Attempt ${attempt}: Getting MCP Client...`);
          const mcpClient = await getMcpClient(); // Will try to connect if needed
          console.log("MCP Client retrieved.");

          let tools: McpTool[] = []; // Store full tool objects
          try {
            const toolsResult: unknown = await mcpClient.listTools();
            if (
              typeof toolsResult === "object" &&
              toolsResult !== null &&
              "tools" in toolsResult &&
              Array.isArray(toolsResult.tools)
            ) {
              // Basic validation for each tool object
              tools = toolsResult.tools.filter(
                (t: unknown): t is McpTool =>
                  typeof t === "object" &&
                  t !== null &&
                  typeof (t as McpTool).name === "string"
              );
            } else {
              console.warn("Unexpected format for listTools result.");
            }
          } catch (toolError) {
            console.error("Error calling or processing listTools:", toolError);

            if (
              typeof toolError === "string" &&
              toolError.includes("Not connected")
            ) {
              markAsDisconnected();
            }
          }

          const toolNames = tools.map((t) => t.name); // Get names for logging if needed
          console.log(`MCP Tools Available: ${toolNames.join(", ")}`);

          // Use the original message text from the thread as query
          // In a production environment, this would be fetched properly
          const messageToProcess = messageText || ""; // Fallback to empty if no text found
          const files: string[] = []; // In a real implementation, you'd retrieve files from storage

          // Process message using the refactored LLM pipeline
          const sendResponse = async (message: string) => {
            if (channelId && threadTs) {
              try {
                if (say && typeof say === "function") {
                  await say({
                    text: message,
                    thread_ts: threadTs,
                    channel: channelId,
                  });
                } else {
                  await client.chat.postMessage({
                    text: message,
                    thread_ts: threadTs,
                    channel: channelId,
                  });
                }
              } catch (sendError) {
                console.error("Error sending LLM response:", sendError);
                // Fallback to response_url if available
                if (typedBody.response_url) {
                  await fetch(typedBody.response_url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      text: message,
                      response_type: "in_channel",
                    }),
                  });
                }
              }
            }
          };

          const llmResponse = await processMessageWithLLM(
            messageToProcess,
            tools,
            files,
            sendResponse
          );

          if (
            llmResponse.error ||
            !llmResponse.tool ||
            !llmResponse.parameters
          ) {
            await sendResponse(
              llmResponse.error || "An error occurred during processing."
            );
            return; // Don't retry if LLM processing failed
          }

          // Format and display the results from the processing pipeline
          // The MCP tool call has already happened in the processing pipeline
          console.log("MCP Tool Call Successful");
          success = true;
          break; // Exit loop on success
        } catch (innerError) {
          console.error(`Attempt ${attempt} failed:`, innerError);
          // Check if the error suggests a connection issue
          const isConnectionError =
            innerError instanceof Error &&
            (innerError.message.includes("connect") ||
              innerError.message.includes("closed") ||
              innerError.message.includes("timeout")); // Add more keywords if needed

          if (isConnectionError && attempt < 2) {
            console.log(
              "Connection error detected, marking as disconnected and retrying..."
            );
            markAsDisconnected(); // Mark for reconnect on next getMcpClient call
            await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait 1s before retry
          } else {
            // Non-connection error or final attempt failed, re-throw to outer catch
            throw innerError;
          }
        }
      } // End of retry loop

      if (!success) {
        // This should ideally be caught by the re-throw above, but as a safeguard:
        throw new Error("MCP Tool call failed after retries.");
      }
    } catch (error) {
      // Outer catch for non-retried errors or final failure
      console.error("Error during Linear search or processing (final):", error);
      try {
        const errorMessage =
          error instanceof Error ? error.message : String(error);

        // Send error message using the most reliable method available
        if (channelId && threadTs) {
          if (say && typeof say === "function") {
            await say({
              text: `Sorry, I encountered an error searching Linear: ${errorMessage}`,
              thread_ts: threadTs,
              channel: channelId,
            });
          } else if (client) {
            await client.chat.postMessage({
              text: `Sorry, I encountered an error searching Linear: ${errorMessage}`,
              thread_ts: threadTs,
              channel: channelId,
            });
          }
        }
      } catch (sayError) {
        console.error("Failed to send error message:", sayError);
      }
    }
  }
);

app.action("ignore_bot", async ({ ack, body, client }) => {
  await ack();
  const typedBody = body as unknown as {
    user?: { id: string };
    response_url?: string;
  };
  const userId = typedBody.user?.id || "unknown";
  console.log(`User ${userId} chose to ignore the bot`);

  // Optionally, provide feedback using response_url
  if (typedBody.response_url) {
    try {
      await fetch(typedBody.response_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "Message dismissed",
          response_type: "ephemeral",
          replace_original: false,
          delete_original: true,
        }),
      });
    } catch (fetchError) {
      console.error("Failed to use response_url:", fetchError);
    }
  }
});

(async () => {
  // Start your app using Socket Mode (no port needed)
  await app.start();

  console.log("⚡️ Bolt app is running using Socket Mode!");
})();
