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
  ImageContent,
} from "./llmquery.js";
import { McpToolName } from "./enums.js";
import path from "node:path";
import fs from "node:fs";

dotenv.config();

type LinearSearchParameters = {
  query: string;
  teamId?: string;
  assigneeId?: string;
  projectId?: string;
  states?: string[]; // status of the issue, usually TODO, In Progress, Done
  limit?: number;
};

// Simple in-memory state store to track user conversations
interface UserState {
  isInEditMode: boolean;
  channelId: string;
  threadTs: string;
  originalMessageText: string;
}

// Track threads where analysis results have been displayed
// Map of threadTs -> {channelId, analysisDisplayTime}
const analysisThreads = new Map<
  string,
  {
    channelId: string;
    displayTime: number; // timestamp when analysis was displayed
  }
>();

// Track threads where searches returned no results
// This helps us know when a user's follow-up message is trying to refine a failed search
const noResultsThreads = new Map<
  string,
  {
    channelId: string;
    originalQuery: string;
    analysisData?: any;
  }
>();

// Track threads where searches returned results
// This helps us know when a user's follow-up message is trying to refine a search with results
const resultsThreads = new Map<
  string,
  {
    channelId: string;
    originalQuery: string;
    analysisData?: any;
  }
>();

// Function to mark a thread as having displayed analysis results
function markThreadWithAnalysis(threadTs: string, channelId: string): void {
  analysisThreads.set(threadTs, {
    channelId,
    displayTime: Date.now(),
  });
  console.log(`Thread ${threadTs} marked as having displayed analysis`);
}

// Function to check if a thread has displayed analysis results
function hasThreadDisplayedAnalysis(
  threadTs: string,
  channelId: string
): boolean {
  const thread = analysisThreads.get(threadTs);
  return !!thread && thread.channelId === channelId;
}

// Function to clear a thread from the analysis tracking
function clearThreadAnalysisTracking(threadTs: string): void {
  if (analysisThreads.has(threadTs)) {
    analysisThreads.delete(threadTs);
    console.log(`Analysis tracking cleared for thread ${threadTs}`);
  }
}

// Function to mark a thread as having no search results
function markThreadNoResults(
  threadTs: string,
  channelId: string,
  originalQuery: string,
  analysisData?: any
): void {
  noResultsThreads.set(threadTs, {
    channelId,
    originalQuery,
    analysisData,
  });
  console.log(
    `Thread ${threadTs} marked as having no search results for query: "${originalQuery}"`
  );
}

// Function to check if a thread had no search results
function hasThreadNoResults(threadTs: string): boolean {
  return noResultsThreads.has(threadTs);
}

// Function to get the original query from a thread with no results
function getNoResultsData(
  threadTs: string
): { originalQuery: string; analysisData?: any } | null {
  const data = noResultsThreads.get(threadTs);
  return data
    ? { originalQuery: data.originalQuery, analysisData: data.analysisData }
    : null;
}

// Function to clear a thread from the no results tracking
function clearThreadNoResultsTracking(threadTs: string): void {
  if (noResultsThreads.has(threadTs)) {
    noResultsThreads.delete(threadTs);
    console.log(`No results tracking cleared for thread ${threadTs}`);
  }
}

// Map to store user states keyed by userId_channelId
const userStates = new Map<string, UserState>();

// Function to generate a consistent key for the user state
function getUserStateKey(userId: string, channelId: string): string {
  return `${userId}_${channelId}`;
}

// Function to check if a user is in edit mode
function isUserInEditMode(userId: string, channelId: string): boolean {
  const key = getUserStateKey(userId, channelId);
  const state = userStates.get(key);
  return state?.isInEditMode || false;
}

// Function to set a user in edit mode
function setUserEditMode(
  userId: string,
  channelId: string,
  threadTs: string,
  originalMessageText: string
): void {
  const key = getUserStateKey(userId, channelId);
  userStates.set(key, {
    isInEditMode: true,
    channelId,
    threadTs,
    originalMessageText,
  });
  console.log(`User ${userId} is now in edit mode`);
}

// Function to clear the edit mode for a user
function clearUserEditMode(userId: string, channelId: string): void {
  const key = getUserStateKey(userId, channelId);
  if (userStates.has(key)) {
    userStates.delete(key);
    console.log(`Edit mode cleared for user ${userId}`);
  }
}

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

    // First check if the user is in edit mode (explicit edit after clicking Edit button)
    if (isUserInEditMode(userId, channelId)) {
      console.log(
        `User ${userId} is in edit mode - handling as edited message`
      );

      // Get the state info
      const stateKey = getUserStateKey(userId, channelId);
      const state = userStates.get(stateKey);

      if (state) {
        // Clear edit mode immediately to prevent recursion
        clearUserEditMode(userId, channelId);

        // Re-run the message analysis with the updated text
        await analyzeMessageContent({
          userId,
          channelId,
          threadTs: state.threadTs, // Use the original thread
          messageText: text, // Use the new message text
          files,
          say,
          client: null,
          isEditedMessage: true,
        });

        return; // Exit to prevent showing the initial greeting
      }
    }

    // Next, check if this message is in a thread where we've displayed analysis results
    // This handles the case where a user sends a message instead of clicking a button
    if (thread_ts && hasThreadDisplayedAnalysis(thread_ts, channelId)) {
      console.log(
        `User ${userId} sent message in analysis thread - treating as implicit edit`
      );

      // Clear the analysis tracking to prevent recursion on future messages
      clearThreadAnalysisTracking(thread_ts);

      // Re-run the analysis with the new message
      await analyzeMessageContent({
        userId,
        channelId,
        threadTs: thread_ts,
        messageText: text,
        files,
        say,
        client: null,
        isEditedMessage: true,
      });

      return; // Exit to prevent showing the initial greeting
    }

    // Check if this message is in a thread where we previously had no search results
    // This allows us to refine the search query with the new information
    if (thread_ts && hasThreadNoResults(thread_ts)) {
      console.log(`User ${userId} is responding to a 'no results' message`);

      // Get the original query data
      const noResultsData = getNoResultsData(thread_ts);

      // Clear the tracking to prevent recursion
      clearThreadNoResultsTracking(thread_ts);

      if (noResultsData) {
        console.log(`Original query was: "${noResultsData.originalQuery}"`);

        // Inform the user we're refining the search
        await say({
          text: "Thanks for the additional information! I'll refine my search...",
          thread_ts,
          channel: channelId,
        });

        // Generate a new search query using both the original and new information
        const refinedQuery = await generateRefinedSearchQuery({
          originalQuery: noResultsData.originalQuery,
          newUserInput: text,
          analysisData: noResultsData.analysisData,
        });

        console.log(`Generated refined query: "${refinedQuery}"`);

        // Execute a new search with the refined query
        await executeLinearSearch({
          query: noResultsData.originalQuery,
          threadTs: thread_ts,
          channelId,
          userId,
          say,
          client: null,
          analysisData: noResultsData.analysisData,
        });

        return; // Exit to prevent showing the initial greeting
      }
    }

    // Check if this message is in a thread where we previously showed search results
    // This allows the user to refine the search with additional context
    if (thread_ts && hasThreadWithResults(thread_ts)) {
      console.log(
        `User ${userId} is responding to a message with search results`
      );

      // Get the original query data
      const resultsData = getThreadResultsData(thread_ts);

      // Clear the tracking to prevent recursion
      clearThreadResultsTracking(thread_ts);

      if (resultsData) {
        console.log(`Original query was: "${resultsData.originalQuery}"`);

        // Inform the user we're refining the search
        await say({
          text: "Thanks for the additional context! I'll refine my search to find more relevant results...",
          thread_ts,
          channel: channelId,
        });

        // Generate a new search query using both the original and new information
        const refinedQuery = await generateRefinedSearchQuery({
          originalQuery: resultsData.originalQuery,
          newUserInput: text,
          analysisData: resultsData.analysisData,
        });

        console.log(`Generated refined query: "${refinedQuery}"`);

        // Execute a new search with the refined query
        await executeLinearSearch({
          query: resultsData.originalQuery,
          threadTs: thread_ts,
          channelId,
          userId,
          say,
          client: null,
          analysisData: resultsData.analysisData,
        });

        return; // Exit to prevent showing the initial greeting
      }
    }

    // Regular flow for new messages
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

  // Check if this is a Socket Mode error
  if (
    error.message &&
    (error.message.includes("socket") ||
      error.message.includes("connection") ||
      error.message.includes("disconnect") ||
      error.message.includes("WebSocket"))
  ) {
    console.log(
      "Socket Mode connection issue detected. Attempting to restart..."
    );

    // In a production app, you might want to implement more sophisticated
    // reconnection logic or notify administrators

    // For Socket Mode errors, we'll try to log extra details if available
    if ((error as any).data) {
      console.error("Socket error details:", (error as any).data);
    }
  }
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
    let files: string[] = [];

    if (typedBody.message?.thread_ts) {
      try {
        // Get the thread history to find the original message
        console.log(
          `Attempting to get thread history for thread: ${threadTs} in channel ${channelId}`
        );

        // Try different timestamp formats, as Slack's API can be inconsistent
        let threadHistory = null;
        let tsAttempts: string[] = [];

        // Add the thread timestamp to the attempts if it's a valid string
        if (threadTs) {
          tsAttempts.push(threadTs);

          // If timestamp contains a dot, also try without it
          if (threadTs.includes(".")) {
            tsAttempts.push(threadTs.split(".")[0]);
          }
        }

        // Try each timestamp format
        for (const ts of tsAttempts) {
          try {
            console.log(`Trying to get thread history with ts=${ts}`);
            const result = await client.conversations.replies({
              channel: channelId || "",
              ts: ts,
            });

            if (result.ok) {
              threadHistory = result;
              console.log(
                `Successfully retrieved thread history with ts=${ts}`
              );
              break;
            }
          } catch (apiError) {
            // Handle Slack API errors - they have a specific format
            const error = apiError as any;
            console.error(`API error with ts=${ts}:`, error?.data || apiError);
          }
        }

        if (
          threadHistory &&
          threadHistory.messages &&
          threadHistory.messages.length > 0
        ) {
          // First message in thread is typically the original one
          const firstMessage = threadHistory.messages[0];
          if (firstMessage && firstMessage.text) {
            messageText = firstMessage.text;
            console.log(
              `Retrieved original message from thread: "${messageText}"`
            );

            // Get any files from the original message
            if (firstMessage.files) {
              files = firstMessage.files
                .map((f: any) => f.url_private_download)
                .filter((url: string | undefined) => url !== undefined);
              console.log(
                `Retrieved ${files.length} files from thread message`
              );
            }
          }
        } else {
          console.log(
            "Could not retrieve thread history or thread has no messages"
          );
          messageText = "Could not retrieve original message";
        }
      } catch (error) {
        console.error("Error fetching thread message:", error);
        messageText = "Error retrieving original message";
      }
    } else {
      // If we're not in a thread, use text from the message containing the button
      messageText = typedBody.message?.text || "";
    }

    console.log(`User ${userId} clicked to analyze message: "${messageText}"`);

    // Call the shared analysis function
    await analyzeMessageContent({
      userId: userId || "unknown",
      channelId: channelId || "",
      threadTs: threadTs || "",
      messageText,
      files,
      say,
      client,
      isEditedMessage: false,
    });
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

// Handler for "Looks good" button in LLM result
app.action("llm_result_confirm", async ({ ack, body, client, say }) => {
  await ack();

  // Type cast for Slack body
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
  const threadTs = typedBody.message?.thread_ts || typedBody.message?.ts;
  const channelId = typedBody.channel?.id;
  const userId = typedBody.user?.id || "unknown";

  console.log(`User ${userId} confirmed the LLM results`);

  // Clear analysis tracking for this thread since a button was clicked
  if (threadTs) {
    clearThreadAnalysisTracking(threadTs);

    // Log the exact threadTs for debugging
    console.log(`Thread timestamp for history lookup: "${threadTs}"`);
    console.log(`Thread timestamp type: ${typeof threadTs}`);
    console.log(`Thread timestamp length: ${threadTs.length}`);

    // Check if it contains a dot which is typical of Slack timestamps
    if (threadTs.includes(".")) {
      console.log(`Thread timestamp contains a dot, which is expected`);
    } else {
      console.log(`Warning: Thread timestamp does not contain a dot`);
    }
  }

  // Helper function to send messages in the thread
  const sendResponse = async (
    message: string | { text: string; blocks?: any[] }
  ) => {
    if (channelId && threadTs) {
      try {
        if (say && typeof say === "function") {
          await say({
            text: typeof message === "string" ? message : message.text,
            blocks: typeof message === "string" ? undefined : message.blocks,
            thread_ts: threadTs,
            channel: channelId,
          });
        } else {
          await client.chat.postMessage({
            text: typeof message === "string" ? message : message.text,
            blocks: typeof message === "string" ? undefined : message.blocks,
            thread_ts: threadTs,
            channel: channelId,
          });
        }
      } catch (sendError) {
        console.error("Error sending response:", sendError);
        // Fallback to response_url if available
        if (typedBody.response_url) {
          await fetch(typedBody.response_url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              text: typeof message === "string" ? message : message.text,
              blocks: typeof message === "string" ? undefined : message.blocks,
              response_type: "in_channel",
            }),
          });
        }
      }
    }
  };

  // Inform the user we're now searching Linear
  await sendResponse("Great! Now searching Linear for related issues...");

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

        // Extract the query from the original message or button context
        // In a real implementation, you would retrieve this from state/storage
        const messageText = typedBody.message?.text || "";

        // Try to extract information from the LLM analysis response in the button message
        let originalMessage = "";
        let llmAnalysis = null;
        let userFeedback = "";

        try {
          // First, try to extract the original message from the UI text
          const messageContent = typedBody.message?.text || "";

          // The LLM analysis response is a structured message with specific sections
          if (messageContent.includes("I've analyzed your message")) {
            // Extract the original message by looking at thread history
            // For now, we'll use placeholder logic
            originalMessage = "Original message would be retrieved from thread";

            // Parse the LLM analysis from the UI message
            // This is a simplistic approach - in a production app, you'd store the actual LLM response
            let llmData: any = {};

            if (messageContent.includes("Product Type:")) {
              const productTypeMatch = messageContent.match(
                /\*Product Type:\* (Web|Mobile|Extension)/i
              );
              if (productTypeMatch && productTypeMatch[1]) {
                llmData.product = productTypeMatch[1];
              }
            }

            if (messageContent.includes("Confidence:")) {
              const confidenceMatch = messageContent.match(
                /\*Confidence:\* (\d+)%/i
              );
              if (confidenceMatch && confidenceMatch[1]) {
                llmData.confidence = parseInt(confidenceMatch[1]) / 100;
              }
            }

            if (messageContent.includes("My understanding:")) {
              const reasoningMatch = messageContent.match(
                /\*My understanding:\* (.*?)(?=\n|$)/s
              );
              if (reasoningMatch && reasoningMatch[1]) {
                llmData.reasoning = reasoningMatch[1].trim();
              }
            }

            llmAnalysis = llmData;

            // Check if this is a response to an edit
            // For now this is placeholder logic - in production, you'd check thread history
            if (messageContent.includes("additional details")) {
              userFeedback =
                "Additional user details would be extracted from thread";
            }

            console.log("Extracted LLM analysis from UI message:", llmAnalysis);
          }
        } catch (extractError) {
          console.log(
            "Error extracting LLM analysis from message:",
            extractError
          );
        }

        // In a production app, you would get this from thread history or state
        // Attempt to get the original user message from thread history
        try {
          if (threadTs && channelId && client) {
            console.log(
              `Attempting to get thread history for thread: ${threadTs} in channel ${channelId}`
            );

            // Try different timestamp formats, as Slack's API can be inconsistent
            let threadHistory = null;
            let tsAttempts: string[] = [];

            // Add the thread timestamp to the attempts if it's a valid string
            if (threadTs) {
              tsAttempts.push(threadTs);

              // If timestamp contains a dot, also try without it
              if (threadTs.includes(".")) {
                tsAttempts.push(threadTs.split(".")[0]);
              }
            }

            // Try each timestamp format
            for (const ts of tsAttempts) {
              try {
                console.log(`Trying to get thread history with ts=${ts}`);
                const result = await client.conversations.replies({
                  channel: channelId,
                  ts: ts,
                });

                if (result.ok) {
                  threadHistory = result;
                  console.log(
                    `Successfully retrieved thread history with ts=${ts}`
                  );
                  break;
                }
              } catch (apiError) {
                // Handle Slack API errors - they have a specific format
                const error = apiError as any;
                console.error(
                  `API error with ts=${ts}:`,
                  error?.data || apiError
                );
              }
            }

            if (
              threadHistory &&
              threadHistory.messages &&
              threadHistory.messages.length > 0
            ) {
              // First message in thread is typically the original one
              const firstMessage = threadHistory.messages[0];
              if (firstMessage && firstMessage.text) {
                originalMessage = firstMessage.text;
                console.log(
                  `Retrieved original message from thread: "${originalMessage}"`
                );
              }

              // Look for messages that might be user feedback (after edit button click)
              // We're looking for messages after our "Please provide more details" message
              let editRequested = false;
              for (const msg of threadHistory.messages) {
                // If this is our edit request message
                if (
                  msg.bot_id &&
                  msg.text &&
                  msg.text.includes("provide more details")
                ) {
                  editRequested = true;
                  continue;
                }

                // If we found an edit request and this is a user message (no bot_id), it's likely feedback
                if (editRequested && !msg.bot_id && msg.text) {
                  userFeedback = msg.text;
                  console.log(`Found user feedback: "${userFeedback}"`);
                  break;
                }
              }
            } else {
              // No valid thread history was found after attempting all timestamp formats
              console.log(
                `Could not retrieve valid thread history after multiple attempts`
              );

              // Try to extract original message from context if possible
              if (!originalMessage && messageText) {
                // Use the text from the current message as a fallback
                originalMessage = messageText;
                console.log(
                  `Using message text as fallback: "${originalMessage}"`
                );
              }
            }
          } else {
            console.log(
              "Cannot retrieve thread history: missing threadTs, channelId, or client"
            );
          }
        } catch (threadError) {
          console.error("Error getting thread history:", threadError);
        }

        // Fallback if we still don't have an original message
        if (!originalMessage) {
          originalMessage =
            "Unable to retrieve original message from thread history";
          console.log("Using fallback for original message");
        }

        console.log(
          `Original message (would be from history): "${originalMessage}"`
        );
        console.log(`LLM analysis extracted: `, llmAnalysis);
        console.log(`User feedback (would be from thread): "${userFeedback}"`);

        // Generate a meaningful search query using all available context
        let searchQuery = await generateLinearSearchQuery({
          originalMessage,
          llmAnalysis: llmAnalysis || {},
          userFeedback,
        });

        console.log(`Generated search query for Linear: "${searchQuery}"`);

        // If the message isn't descriptive enough, use a better default
        if (!searchQuery || searchQuery.length < 5) {
          searchQuery = llmAnalysis?.product
            ? `${llmAnalysis.product} recent issues`
            : "recent issues";
          console.log(`Using fallback search query: "${searchQuery}"`);
        }

        // Execute the Linear search
        await executeLinearSearch({
          query: originalMessage,
          threadTs: threadTs || "",
          channelId: channelId || "",
          userId,
          say,
          client,
          analysisData: llmAnalysis,
        });

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
      throw new Error("Linear search failed after retries.");
    }
  } catch (error) {
    // Handle any errors during the Linear search
    console.error("Error during Linear search:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    await sendResponse(
      `Sorry, I encountered an error searching Linear: ${errorMessage}`
    );
  }
});

// Handler for "Edit" button in LLM result
app.action("llm_result_edit", async ({ ack, body, client, say }) => {
  await ack();

  // Type cast for Slack body
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
  const threadTs = typedBody.message?.thread_ts || typedBody.message?.ts;
  const channelId = typedBody.channel?.id;
  const userId = typedBody.user?.id || "unknown";
  const messageText = typedBody.message?.text || "";

  console.log(`User ${userId} wants to edit the LLM results`);

  // Clear analysis tracking for this thread since a button was clicked
  if (threadTs) {
    clearThreadAnalysisTracking(threadTs);
  }

  // Set the user in edit mode so we can handle their follow-up message
  if (channelId) {
    setUserEditMode(userId, channelId, threadTs || "", messageText);
  }

  // Ask for more information
  if (channelId && threadTs) {
    try {
      await client.chat.postMessage({
        text: "Please provide more details about what you're looking for, and I'll try again:",
        thread_ts: threadTs,
        channel: channelId,
      });

      // The user's next message in this thread will be handled by the message handler,
      // which will detect edit mode and process it accordingly
    } catch (error) {
      console.error("Error sending edit request message:", error);

      // Clear edit mode if we couldn't send the message
      if (channelId) {
        clearUserEditMode(userId, channelId);
      }
    }
  }
});

// Handler for "Cancel flow" button in LLM result
app.action("llm_result_cancel", async ({ ack, body, client, say }) => {
  await ack();

  // Type cast for Slack body
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
  const threadTs = typedBody.message?.thread_ts || typedBody.message?.ts;
  const channelId = typedBody.channel?.id;
  const userId = typedBody.user?.id || "unknown";

  console.log(`User ${userId} cancelled the flow`);

  // Clear analysis tracking for this thread since a button was clicked
  if (threadTs) {
    clearThreadAnalysisTracking(threadTs);
  }

  // Send cancellation message
  if (channelId && threadTs) {
    try {
      await client.chat.postMessage({
        text: "I've cancelled the search. Feel free to start a new conversation anytime!",
        thread_ts: threadTs,
        channel: channelId,
      });
    } catch (error) {
      console.error("Error sending cancellation message:", error);
    }
  }
});

// Handler for "I'm good" button in the no results scenario
app.action("end_conversation", async ({ ack, body, client, say }) => {
  await ack();

  // Type cast for Slack body
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
  const threadTs = typedBody.message?.thread_ts || typedBody.message?.ts;
  const channelId = typedBody.channel?.id;
  const userId = typedBody.user?.id || "unknown";

  console.log(`User ${userId} chose to end the conversation`);

  // Clear any tracking for this thread
  if (threadTs) {
    clearThreadNoResultsTracking(threadTs);
  }

  // Send a friendly closing message
  if (channelId && threadTs) {
    try {
      await client.chat.postMessage({
        text: "No problem! Feel free to start a new conversation anytime you need help with Linear issues.",
        thread_ts: threadTs,
        channel: channelId,
      });
    } catch (error) {
      console.error("Error sending closing message:", error);
    }
  }
});

// Handler for "Looks good!" button when results are helpful
app.action("results_helpful", async ({ ack, body, client, say }) => {
  await ack();

  // Type cast for Slack body
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
  const threadTs = typedBody.message?.thread_ts || typedBody.message?.ts;
  const channelId = typedBody.channel?.id;
  const userId = typedBody.user?.id || "unknown";

  console.log(`User ${userId} found the search results helpful`);

  // Clear results tracking for this thread
  if (threadTs) {
    clearThreadResultsTracking(threadTs);
  }

  // Send an acknowledgment message
  if (channelId && threadTs) {
    try {
      await client.chat.postMessage({
        text: "Great! I'm glad these results were helpful. Feel free to start a new conversation anytime you need more assistance with Linear issues.",
        thread_ts: threadTs,
        channel: channelId,
      });

      // In a production app, you might want to log this feedback for analytics
      console.log(
        `Feedback logged: User ${userId} found results helpful in thread ${threadTs}`
      );
    } catch (error) {
      console.error("Error sending feedback acknowledgment:", error);
    }
  }
});

// Extract the message analysis logic into a reusable function
async function analyzeMessageContent({
  userId,
  channelId,
  threadTs,
  messageText,
  files = [],
  say,
  client,
  isEditedMessage = false,
}: {
  userId: string;
  channelId: string;
  threadTs: string;
  messageText: string;
  files?: string[];
  say: any;
  client?: any;
  isEditedMessage?: boolean;
}): Promise<void> {
  // Define the sendResponse function for sending UI responses
  const sendResponse = async (
    message: string | { text: string; blocks?: any[] }
  ) => {
    if (channelId && threadTs) {
      try {
        if (say && typeof say === "function") {
          await say({
            text: typeof message === "string" ? message : message.text,
            blocks: typeof message === "string" ? undefined : message.blocks,
            thread_ts: threadTs,
            channel: channelId,
          });
        } else if (client) {
          await client.chat.postMessage({
            text: typeof message === "string" ? message : message.text,
            blocks: typeof message === "string" ? undefined : message.blocks,
            thread_ts: threadTs,
            channel: channelId,
          });
        } else {
          console.error(
            "No way to send a response - both say and client are unavailable"
          );
          return;
        }
      } catch (sendError) {
        console.error("Error sending response:", sendError);
      }
    }
  };

  try {
    // Show a message that we're analyzing the content
    if (isEditedMessage) {
      await sendResponse(
        "Thanks for the additional details! Analyzing your updated message..."
      );
    } else {
      await sendResponse("Analyzing your message...");
    }

    // Call the OpenAI API directly for demonstration
    const { OpenAI } = await import("openai");
    const llm = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    // Get the prompt text for LLM analysis
    let prompt;
    try {
      const fs = await import("node:fs");
      prompt = await fs.promises.readFile(
        "src/prompts/detect_product.txt",
        "utf-8"
      );
    } catch (err) {
      console.error("Failed to read prompt file:", err);
      prompt =
        "Analyze the following message and extract:\n" +
        "- product type (Web/Mobile/Extension)\n" +
        "- confidence level (0-1)\n" +
        "- reasoning\n\n" +
        "IMPORTANT: Only include image_description field if <has_images>true</has_images> is specified after the message.\n\n" +
        "Respond in JSON format.";
    }

      // Download and convert images to base64
      const imageContents: ImageContent[] = [];
    if (files.length > 0) {
      // Ensure temp directory exists for saving images
      const tempDir = path.join(process.cwd(), "temp");
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      for (const fileUrl of files) {
        try {
          // Generate a unique filename for the image
          const fileExtension = path.extname(fileUrl) || ".jpg";
          const fileName = `image_${Date.now()}_${Math.floor(
            Math.random() * 1000
          )}${fileExtension}`;
          const filePath = path.join(tempDir, fileName);

          console.log(`Downloading image from ${fileUrl}`);
          // Download the image using fetch
          const response = await fetch(fileUrl, {
            headers: {
              Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
            },
          });

          // Get the array buffer from the response
          const arrayBuffer = await response.arrayBuffer();

          // Save the file locally
          fs.writeFileSync(filePath, Buffer.from(arrayBuffer));
          console.log(`Saved image to ${filePath}`);

          // Read the file and convert to base64
          const base64Image = fs.readFileSync(filePath, "base64");

          // Determine mime type based on file extension
          const extension = path.extname(fileUrl).toLowerCase();
          let mimeType = "image/jpeg"; // Default
          if (extension === ".png") mimeType = "image/png";
          else if (extension === ".gif") mimeType = "image/gif";
          else if (extension === ".webp") mimeType = "image/webp";

          imageContents.push({
            type: "input_image" as const,
            image_url: `data:${mimeType};base64,${base64Image}`,
            detail: "auto" as const,
          });
        } catch (error) {
          console.error(`Error downloading image ${fileUrl}:`, error);
        }
      }
    }

    // Call the LLM
    const response = await llm.responses.create({
      model: "gpt-4o",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `${prompt}\n<message>\n${messageText}\n</message>\n<has_images>${
                files.length > 0
              }</has_images>`,
            },
            ...imageContents,
          ],
        },
      ],
    });

    // Parse the response into a structured format
    const cleanedResponse = response.output_text
      .replace(/^```json\n/, "")
      .replace(/\n```$/, "");
    console.log("Raw LLM response:", cleanedResponse);

    let typedOutput;
    try {
      typedOutput = JSON.parse(cleanedResponse);
    } catch (parseError) {
      console.error("Failed to parse LLM response as JSON:", parseError);
      await sendResponse(
        "Sorry, I had trouble understanding the message content. Please try again."
      );
      return;
    }

    // Create a user-friendly message with the extracted information
    let userFriendlyMessage =
      "I've analyzed your message and here's what I found:\n\n";

    if (typedOutput.product) {
      userFriendlyMessage += `*Product Type:* ${typedOutput.product}\n`;
    }

    if (typedOutput.confidence !== undefined) {
      const confidencePercent = Math.round(typedOutput.confidence * 100);
      userFriendlyMessage += `*Confidence:* ${confidencePercent}%\n`;
    }

    // Only display image description if images were actually attached and the LLM provided a description
    if (files.length > 0 && typedOutput.image_description) {
      userFriendlyMessage += `*Image Analysis:* ${typedOutput.image_description}\n`;
    }

    if (typedOutput.reasoning) {
      userFriendlyMessage += `\n*My understanding:* ${typedOutput.reasoning}\n`;
    }

    userFriendlyMessage +=
      "\nDoes this look right to you? You can also reply directly with more details instead of clicking a button.";

    // Send the message with the three buttons
    await sendResponse({
      text: userFriendlyMessage,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: userFriendlyMessage,
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "Looks good",
              },
              style: "primary", // Green background
              action_id: "llm_result_confirm",
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "Edit",
              },
              action_id: "llm_result_edit",
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "Cancel flow",
              },
              style: "danger", // Red background
              action_id: "llm_result_cancel",
            },
          ],
        },
      ],
    });

    // Store the LLM output in a context/state mechanism for later use
    // In a real implementation, you would store this in a database or state manager
    console.log("Storing analysis result for later:", typedOutput);

    // Mark the thread as having displayed analysis results
    if (threadTs) {
      markThreadWithAnalysis(threadTs, channelId);
    }
  } catch (error) {
    console.error("Error during message analysis:", error);

    // Send error message to the user
    const errorMessage = error instanceof Error ? error.message : String(error);
    await sendResponse(
      `Sorry, I encountered an error analyzing your message: ${errorMessage}`
    );
  }
}

// Function to optimize a search query for Linear using OpenAI
async function optimizeSearchQuery(query: string): Promise<string> {
  // If the query is already short enough, return it as is
  if (query.length <= 256) {
    return query;
  }

  // Create a prompt for OpenAI to optimize the query
  const prompt = `
You are assisting in optimizing a search query for Linear (issue tracking system).
The original search query is too long and needs to be shortened to fit within 256 characters.

Original query: "${query}"

Rules:
1. Your output MUST be 256 characters or fewer
2. Preserve the most important keywords and context
3. Remove unnecessary words, articles, and filler content
4. Focus on technical terms, product names, and descriptive adjectives
5. Output ONLY the optimized query, nothing else - no explanations or comments

Optimized query:`;

  try {
    // Call OpenAI to optimize the query
    const { OpenAI } = await import("openai");
    const llm = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    console.log("Sending query to OpenAI for optimization:", query);

    const response = await llm.completions.create({
      model: "gpt-3.5-turbo-instruct",
      prompt,
      max_tokens: 100,
      temperature: 0.3,
    });

    const optimizedQuery = response.choices[0]?.text?.trim() || "";

    console.log(
      `Optimized query: "${optimizedQuery}" (${optimizedQuery.length} chars)`
    );

    // As a final safety check, still truncate if somehow the optimization went wrong
    return optimizedQuery.length <= 256
      ? optimizedQuery
      : optimizedQuery.substring(0, 256);
  } catch (error) {
    console.error("Error optimizing query:", error);
    // Fallback: simply truncate the query if optimization fails
    return query.substring(0, 256);
  }
}

// Function to generate a meaningful search query for Linear using all available context
async function generateLinearSearchQuery({
  originalMessage,
  llmAnalysis,
  userFeedback = "",
}: {
  originalMessage: string;
  llmAnalysis: any;
  userFeedback?: string;
}): Promise<string> {
  // Prepare all the context we have
  const productType = llmAnalysis?.product || "";
  const reasoning = llmAnalysis?.reasoning || "";

  // Create a prompt for the LLM to generate a good search query
  const prompt = `
You are assisting in creating an optimal search query for Linear (issue tracking system).
Your task is to create a concise, meaningful search query that will find the most relevant issues.

CONTEXT:
Original user message: "${originalMessage}"
Extracted product type: "${productType}"
Understanding of message: "${reasoning}"
${userFeedback ? `Additional user feedback: "${userFeedback}"` : ""}

REQUIREMENTS:
1. The query MUST be 256 characters or fewer
2. Focus on technical terms, specific features, product names, and error descriptions
3. Include the product type (${productType || "unspecified"}) if relevant
4. Prioritize specific error messages or feature names mentioned
5. Remove conversational elements and focus on search keywords
6. Format should be like a search engine query (keywords, not natural language)
7. Output ONLY the search query, nothing else

Generated search query:`;

  try {
    // Call OpenAI to generate the query
    const { OpenAI } = await import("openai");
    const llm = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    console.log("Generating optimal Linear search query from all context");

    const response = await llm.completions.create({
      model: "gpt-3.5-turbo-instruct",
      prompt,
      max_tokens: 150,
      temperature: 0.4,
    });

    const searchQuery = response.choices[0]?.text?.trim() || "";

    console.log(
      `Generated search query: "${searchQuery}" (${searchQuery.length} chars)`
    );

    // Ensure the query is not empty and within limits
    if (!searchQuery) {
      console.warn("Generated empty search query, falling back to defaults");
      return productType || "recent issues";
    }

    // If somehow still too long, truncate (should be rare with the prompt constraints)
    return searchQuery.length <= 256
      ? searchQuery
      : searchQuery.substring(0, 256);
  } catch (error) {
    console.error("Error generating search query:", error);
    // Fallback: use product type or a generic query
    return productType ? `${productType} issues` : "recent issues";
  }
}

// Function to generate a refined search query using previous query and new user input
async function generateRefinedSearchQuery({
  originalQuery,
  newUserInput,
  analysisData = {},
}: {
  originalQuery: string;
  newUserInput: string;
  analysisData?: any;
}): Promise<string> {
  // Create a prompt for the LLM to generate an improved search query
  const prompt = `
You are assisting in refining a search query for Linear (issue tracking system).
The original search returned no results, and the user has provided additional information.

CONTEXT:
Original search query: "${originalQuery}"
Additional user input: "${newUserInput}"
Product type: "${analysisData?.product || "Unknown"}"

REQUIREMENTS:
1. Create a new, more effective search query that combines the original context with the new information
2. The query MUST be 256 characters or fewer
3. Focus on technical terms, specific features, product names, and error descriptions
4. Include the product type if relevant
5. Prioritize specific error messages or feature names mentioned in the new input
6. Format should be like a search engine query (keywords, not natural language)
7. Output ONLY the refined search query, nothing else

Refined search query:`;

  try {
    // Call OpenAI to generate the query
    const { OpenAI } = await import("openai");
    const llm = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    console.log("Generating refined search query with new user input");

    const response = await llm.completions.create({
      model: "gpt-3.5-turbo-instruct",
      prompt,
      max_tokens: 150,
      temperature: 0.4,
    });

    const refinedQuery = response.choices[0]?.text?.trim() || "";

    console.log(
      `Refined search query: "${refinedQuery}" (${refinedQuery.length} chars)`
    );

    // If the refined query is empty, fall back to original + new input (truncated if needed)
    if (!refinedQuery) {
      console.warn("Failed to generate a refined query, using fallback");
      const fallbackQuery = `${originalQuery} ${newUserInput}`.trim();
      return fallbackQuery.length <= 256
        ? fallbackQuery
        : fallbackQuery.substring(0, 256);
    }

    // If somehow too long, truncate (should be rare with the prompt constraints)
    return refinedQuery.length <= 256
      ? refinedQuery
      : refinedQuery.substring(0, 256);
  } catch (error) {
    console.error("Error generating refined search query:", error);
    // Fallback: combine original query with new input
    const fallbackQuery = `${originalQuery} ${newUserInput}`.trim();
    return fallbackQuery.length <= 256
      ? fallbackQuery
      : fallbackQuery.substring(0, 256);
  }
}

// Function to execute a Linear search
async function executeLinearSearch({
  query,
  threadTs,
  channelId,
  userId,
  say,
  client,
  analysisData = {},
}: {
  query: string;
  threadTs: string;
  channelId: string;
  userId: string;
  say: any;
  client: any;
  analysisData?: any;
}): Promise<void> {
  // Define response helper function
  const sendResponse = async (
    message: string | { text: string; blocks?: any[] }
  ) => {
    if (channelId && threadTs) {
      try {
        if (say && typeof say === "function") {
          await say({
            text: typeof message === "string" ? message : message.text,
            blocks: typeof message === "string" ? undefined : message.blocks,
            thread_ts: threadTs,
            channel: channelId,
          });
        } else if (client) {
          await client.chat.postMessage({
            text: typeof message === "string" ? message : message.text,
            blocks: typeof message === "string" ? undefined : message.blocks,
            thread_ts: threadTs,
            channel: channelId,
          });
        } else {
          console.error(
            "No way to send a response - both say and client are unavailable"
          );
          return;
        }
      } catch (sendError) {
        console.error("Error sending response:", sendError);
      }
    }
  };

  try {
    // Use a loop for potential retries on connection failure
    let success = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`Attempt ${attempt}: Getting MCP Client for search...`);
        const mcpClient = await getMcpClient();
        console.log("MCP Client retrieved for search.");

        // Get available tools
        let tools: McpTool[] = [];
        try {
          const toolsResult: unknown = await mcpClient.listTools();
          if (
            typeof toolsResult === "object" &&
            toolsResult !== null &&
            "tools" in toolsResult &&
            Array.isArray(toolsResult.tools)
          ) {
            tools = toolsResult.tools.filter(
              (t: unknown): t is McpTool =>
                typeof t === "object" &&
                t !== null &&
                typeof (t as McpTool).name === "string"
            );
          }
        } catch (toolError) {
          console.error("Error getting tools:", toolError);
          if (
            typeof toolError === "string" &&
            toolError.includes("Not connected")
          ) {
            markAsDisconnected();
          }
          throw toolError;
        }

        // Find the search tool
        const searchTool = tools.find(
          (t) => t.name === McpToolName.SearchIssues
        );
        if (!searchTool) {
          throw new Error("Linear search tool not available");
        }

        console.log(
          `Found ${McpToolName.SearchIssues} tool. Searching with query: "${query}"`
        );

        // Prepare search parameters
        const parameters: LinearSearchParameters = {
          query,
          limit: 10,
        };

        // Call the Linear search tool
        const result = await mcpClient.callTool({
          name: searchTool.name,
          arguments: parameters,
        });

        console.log("Linear search completed");

        // Process the search results
        let linearIssues: any[] = [];
        try {
          if (
            result &&
            typeof result === "object" &&
            "content" in result &&
            Array.isArray(result.content) &&
            result.content.length > 0 &&
            result.content[0] &&
            "text" in result.content[0]
          ) {
            const textContent = result.content[0].text as string;

            // Check if the response contains an error
            if (textContent.trim().startsWith("Error:")) {
              console.error("Linear API returned an error:", textContent);
              await sendResponse(`Error from Linear: ${textContent.trim()}`);
              return;
            }

            try {
              linearIssues = JSON.parse(textContent);
            } catch (error) {
              const jsonError = error as Error;
              console.error("Error parsing Linear results as JSON:", jsonError);
              console.error("Raw response was:", textContent);
              await sendResponse(
                `Error processing Linear results: ${jsonError.message}`
              );
              return;
            }
          } else {
            console.warn("Unexpected response format from Linear API:", result);
            await sendResponse(
              "Received an unexpected response format from Linear. Please try again."
            );
            return;
          }
        } catch (error) {
          const parseError = error as Error;
          console.error("Error processing search results:", parseError);
          await sendResponse(`Error processing results: ${parseError.message}`);
          return;
        }

        // Check if we found any results
        if (!Array.isArray(linearIssues) || linearIssues.length === 0) {
          console.log("No matching issues found in Linear");

          // Save the query and analysis data for potential refinement
          markThreadNoResults(threadTs, channelId, query, analysisData);

          // Send a friendly no-results message with an option to end the conversation
          await sendResponse({
            text: "I'm sorry, but I couldn't find any results matching your query. Would you like to add more context so we can try again?",
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: "I'm sorry, but I couldn't find any results matching your query. Would you like to add more context so we can try again?",
                },
              },
              {
                type: "actions",
                elements: [
                  {
                    type: "button",
                    text: {
                      type: "plain_text",
                      text: "I'm good",
                    },
                    style: "primary",
                    action_id: "end_conversation",
                  },
                ],
              },
            ],
          });
          return;
        }

        // Format the results
        const limitedIssues = linearIssues.slice(0, 5);
        let formattedResults =
          "Here are the related issues I found in Linear. If none of these are what you're looking for, reply to this message with more context and I'll refine the search!\n\n";

        limitedIssues.forEach((issue: any, index: number) => {
          const title = issue.title || "No title";
          const status = issue.status || "No status";
          const url = issue.url || "#";

          formattedResults += `*${index + 1}. <${url}|${title}>*\n`;
          formattedResults += `*Status:* ${status}\n`;

          // Add description if available
          const description = issue.metadata?.context?.description?.snippet;
          if (description) {
            formattedResults += `*Description:* ${description}\n`;
          }

          formattedResults += "\n";
        });

        // Add a note about replying with more context
        formattedResults +=
          "If these results aren't exactly what you're looking for, you can reply with more context and I'll refine the search.";

        // Save the query and analysis data for potential refinement
        markThreadWithResults(threadTs, channelId, query, analysisData);

        // Send the formatted results to the user with a feedback button
        await sendResponse({
          text: formattedResults,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: formattedResults,
              },
            },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: {
                    type: "plain_text",
                    text: "Looks good!",
                  },
                  style: "primary", // Green background
                  action_id: "results_helpful",
                },
              ],
            },
          ],
        });

        success = true;
        break; // Exit loop on success
      } catch (innerError) {
        console.error(`Attempt ${attempt} failed:`, innerError);

        // Check if it's a connection error
        const isConnectionError =
          innerError instanceof Error &&
          (innerError.message.includes("connect") ||
            innerError.message.includes("closed") ||
            innerError.message.includes("timeout"));

        if (isConnectionError && attempt < 2) {
          console.log("Connection error detected, retrying...");
          markAsDisconnected();
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } else {
          throw innerError;
        }
      }
    }

    if (!success) {
      throw new Error("Linear search failed after retries");
    }
  } catch (error) {
    console.error("Error during Linear search:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    await sendResponse(
      `Sorry, I encountered an error searching Linear: ${errorMessage}`
    );
  }
}

// Function to mark a thread as having search results
function markThreadWithResults(
  threadTs: string,
  channelId: string,
  originalQuery: string,
  analysisData?: any
): void {
  resultsThreads.set(threadTs, {
    channelId,
    originalQuery,
    analysisData,
  });
  console.log(
    `Thread ${threadTs} marked as having search results for query: "${originalQuery}"`
  );
}

// Function to check if a thread had search results
function hasThreadWithResults(threadTs: string): boolean {
  return resultsThreads.has(threadTs);
}

// Function to get the original query from a thread with results
function getThreadResultsData(
  threadTs: string
): { originalQuery: string; analysisData?: any } | null {
  const data = resultsThreads.get(threadTs);
  return data
    ? { originalQuery: data.originalQuery, analysisData: data.analysisData }
    : null;
}

// Function to clear a thread from the results tracking
function clearThreadResultsTracking(threadTs: string): void {
  if (resultsThreads.has(threadTs)) {
    resultsThreads.delete(threadTs);
    console.log(`Results tracking cleared for thread ${threadTs}`);
  }
}

(async () => {
  // Start your app using Socket Mode (no port needed)
  try {
    console.log("Starting Slack app in Socket Mode...");
    await app.start();
    console.log("⚡️ Bolt app is running using Socket Mode!");
  } catch (error) {
    console.error("❌ Error starting app:", error);

    // Check if the error is related to Socket Mode
    const errorMessage = (error as Error).message || "";
    if (
      errorMessage.includes("socket") ||
      errorMessage.includes("connection") ||
      errorMessage.includes("disconnect") ||
      errorMessage.includes("Socket Mode")
    ) {
      console.error("Socket Mode connection error. Please check:");
      console.error(
        "1. Your app token is valid and has the connections:write scope"
      );
      console.error(
        "2. Socket Mode is enabled for your app in the Slack API dashboard"
      );
      console.error("3. Your network allows WebSocket connections");

      // In a production app, you might implement a retry mechanism here
      console.error("Please fix the issues and restart the app");
      process.exit(1);
    }
  }
})();
