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
import { McpToolName } from "./enums.js";

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

    // Check if the user is in edit mode
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

    console.log(`User ${userId} clicked to analyze message: "${messageText}"`);

    // Call the shared analysis function
    await analyzeMessageContent({
      userId: userId || "unknown",
      channelId: channelId || "",
      threadTs: threadTs || "",
      messageText,
      files: [],
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

        // Try to extract a more focused search query from the message text
        let searchQuery = messageText;

        // See if we can extract LLM analysis data from the button message to improve the search
        try {
          const messageContent = typedBody.message?.text || "";
          if (messageContent.includes("Product Type:")) {
            // Try to extract the product type from the message text
            const productTypeMatch = messageContent.match(
              /\*Product Type:\* (Web|Mobile|Extension)/i
            );
            if (productTypeMatch && productTypeMatch[1]) {
              // Add the product type to the search query for better results
              searchQuery = `${productTypeMatch[1]} ${searchQuery}`;
              console.log(
                `Enhanced search query with product type: "${searchQuery}"`
              );
            }
          }
        } catch (extractError) {
          console.log(
            "Could not extract additional context from LLM analysis:",
            extractError
          );
        }

        // If the message isn't descriptive enough (like the placeholder), use a better default
        if (
          searchQuery === "Extracted from thread" ||
          searchQuery.length < 10
        ) {
          searchQuery = "recent issues";
        }

        console.log(`Using search query for Linear: "${searchQuery}"`);

        // Optimize the search query to fit Linear's 256 character limit
        searchQuery = await optimizeSearchQuery(searchQuery);
        console.log(
          `Optimized search query: "${searchQuery}" (${searchQuery.length} chars)`
        );

        // Search Linear using the Linear tool
        const searchTool = tools.find(
          (t) => t.name === McpToolName.SearchIssues
        );

        if (!searchTool) {
          throw new Error("Linear search tool not available");
        }

        console.log(
          `Found ${McpToolName.SearchIssues} tool. Preparing to search Linear...`
        );

        // Prepare search parameters
        const parameters: LinearSearchParameters = {
          query: searchQuery,
          limit: 10,
        };

        // Call the Linear search tool directly
        const result = await mcpClient.callTool({
          name: searchTool.name,
          arguments: parameters,
        });

        console.log("Linear search successful");

        // Format and display the search results
        // This logic would typically be in a separate function or component
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
                `Error processing Linear results: ${
                  jsonError.message
                }\n\nRaw response: ${textContent.slice(0, 100)}...`
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
          console.error("Error processing Linear search results:", parseError);
          await sendResponse(`Error processing results: ${parseError.message}`);
          return;
        }

        if (!Array.isArray(linearIssues) || linearIssues.length === 0) {
          await sendResponse("No matching issues found in Linear.");
          return;
        }

        // Format the results
        const limitedIssues = linearIssues.slice(0, 5);
        let formattedResults =
          "Here are the related issues I found in Linear:\n\n";

        limitedIssues.forEach((issue: any, index: number) => {
          const title = issue.title || "No title";
          const status = issue.status || "No status";
          const url = issue.url || "#";
          const description =
            issue.metadata?.context?.description?.snippet || "No description";

          formattedResults += `*${index + 1}. <${url}|${title}>*\n`;
          formattedResults += `*Status:* ${status}\n`;
          formattedResults += `*Description:* ${description}\n\n`;
        });

        // Send the formatted results to the user
        await sendResponse(formattedResults);

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
        "Analyze the following message and extract:\n- product type (Web/Mobile/Extension)\n- confidence level (0-1)\n- reasoning\nRespond in JSON format.";
    }

    // Call the LLM
    const response = await llm.responses.create({
      model: "gpt-4o-mini",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `${prompt}\n<message>\n${messageText}\n</message>`,
            },
          ],
        },
      ],
    });

    // Parse the response into a structured format
    console.log("Raw LLM response:", response.output_text);

    let typedOutput;
    try {
      typedOutput = JSON.parse(response.output_text);
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

    if (typedOutput.image_description) {
      userFriendlyMessage += `*Image Analysis:* ${typedOutput.image_description}\n`;
    }

    if (typedOutput.reasoning) {
      userFriendlyMessage += `\n*My understanding:* ${typedOutput.reasoning}\n`;
    }

    userFriendlyMessage += "\nDoes this look right to you?";

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

(async () => {
  // Start your app using Socket Mode (no port needed)
  await app.start();

  console.log("⚡️ Bolt app is running using Socket Mode!");
})();
