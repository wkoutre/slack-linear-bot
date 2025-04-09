import Bolt, {
  AllMiddlewareArgs,
  SlackEventMiddlewareArgs,
  GenericMessageEvent, // Import specific message type
} from "@slack/bolt";
import dotenv from "dotenv";
import { getMcpClient, markAsDisconnected } from "./mcp_client.js"; // Import MCP client and markAsDisconnected
import util from "util"; // For formatting the output
import { McpToolName } from "./enums.js";

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

// Define expected type for a tool object from listTools
// (Making it more specific based on common MCP patterns)
type McpTool = {
  name: McpToolName;
  description?: string;
  arguments?: any; // Adjust as needed based on actual SDK types
  // Add other potential properties if known
};

// Interface for the expected LLM response - uses McpTool now
interface LlmResponse {
  tool: McpTool | null;
  parameters: Record<string, any> | null;
  error?: string; // Optional error message from LLM/processing
}

// Updated placeholder function: Always targets search_issues
async function processMessageWithLLM(
  text: string,
  availableTools: McpTool[]
): Promise<LlmResponse> {
  console.log("Processing message (placeholder logic):", text);
  const availableToolNames = availableTools.map((t) => t.name);
  console.log("Available tools:", availableToolNames);

  // --- Step 1: LLM Parsing/Clarification Placeholder ---
  // When LLM is available, it would process 'text' here.
  // The output should ideally be a structured query or parameters.
  // For now, we'll use the raw text as the search query.
  const processedQuery = text;
  // --- End LLM Placeholder ---

  // --- Step 2: Always find and prepare the search tool ---
  const searchTool = availableTools.find(
    (t) => t.name === McpToolName.SearchIssues
  );

  if (searchTool) {
    console.log(`Found ${McpToolName.SearchIssues} tool. Preparing call.`);
    return {
      tool: searchTool,
      parameters: { query: processedQuery }, // Use processed text from (future) LLM
    };
  }

  // Fallback if search tool isn't available for some reason
  console.error(
    `${McpToolName.SearchIssues} tool not found in available tools!`
  );
  return {
    tool: null,
    parameters: null,
    error: "Linear search tool is currently unavailable.",
  };
}

// Listen to any message posted in a channel the bot is part of or DMs
app.message(async ({ message, say }: SlackEventMiddlewareArgs<"message">) => {
  // Check if it's a regular user message (not a subtype like edit/delete/join)
  if (message.subtype === undefined) {
    // Cast to GenericMessageEvent for type safety
    const userMessage = message as GenericMessageEvent;

    // Ignore messages from bots or system messages without a user
    if (!userMessage.user) {
      return;
    }

    const text = userMessage.text || "";
    const userId = userMessage.user;
    const channelId = userMessage.channel; // Explicitly get channel ID
    const thread_ts = userMessage.thread_ts || userMessage.ts;

    console.log(
      `Received message from ${userId} in channel ${channelId}: "${text}"`
    );

    // Use the say function from the context for acknowledgement
    await say({ text: "Searching Linear for related issues...", thread_ts });

    try {
      // Use a loop for potential retries on connection failure
      let result = null;
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

          // Process message - Step 1 (placeholder) & Step 2 (prepare search)
          const llmResponse = await processMessageWithLLM(text, tools);

          if (
            llmResponse.error ||
            !llmResponse.tool ||
            !llmResponse.parameters
          ) {
            await say({ text: llmResponse.error || "...", thread_ts });
            return; // Don't retry if LLM processing failed
          }

          console.log(
            `Attempt ${attempt}: Calling tool: ${llmResponse.tool.name} with params:`,
            llmResponse.parameters
          );

          // Call the search tool
          result = await mcpClient.callTool({
            name: llmResponse.tool.name,
            arguments: {
              ...llmResponse.parameters,
              first: 10,
            },
          });

          console.log("MCP Tool Call Successful");
          success = true;
          break; // Exit loop on success
        } catch (innerError) {
          console.error(`Attempt ${attempt} failed:`, innerError);
          // Check if the error suggests a connection issue
          // (Customize this check based on actual errors seen)
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

      console.log("MCP Tool Result:", result);
      const formattedResult =
        "```\n" +
        util.inspect(result, { depth: null, colors: false }) +
        "\n```";
      await say({
        text: `Found potential matches in Linear:\n${formattedResult}`,
        thread_ts: thread_ts,
      });
    } catch (error) {
      // Outer catch for non-retried errors or final failure
      console.error("Error during Linear search or processing (final):", error);
      try {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        await say({
          text: `Sorry, I encountered an error searching Linear: ${errorMessage}`,
          thread_ts: thread_ts,
        });
      } catch (sayError) {
        console.error("Failed to send error message using say():", sayError);
      }
    }
  }
});

// Basic error handler
app.error(async (error: Error) => {
  console.error("Bolt app error:", error);
});

(async () => {
  // Start your app using Socket Mode (no port needed)
  await app.start();

  console.log("⚡️ Bolt app is running using Socket Mode!");
})();
