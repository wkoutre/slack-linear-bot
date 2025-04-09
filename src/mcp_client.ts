// Polyfill WebSocket for Node.js environment
import WebSocket from "ws";
if (typeof global.WebSocket === "undefined") {
  (global as any).WebSocket = WebSocket;
}

import { WebSocketClientTransport } from "@modelcontextprotocol/sdk/client/websocket.js";
import { createTransport } from "@smithery/sdk/transport.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import "dotenv/config"; // Ensure environment variables are loaded
import { McpToolName } from "./enums.js";
import { createUrl } from "./utils.js";

const linearApiKey = process.env.LINEAR_API_KEY;
const smitheryApiKey = process.env.SMITHERY_API_KEY;
const useLocalMcp = process.env.USE_LOCAL_MCP === "true";
const localMcpUrl = process.env.LOCAL_MCP_URL || "ws://localhost:3000/mcp";
const useHttpForLocal = process.env.USE_HTTP_FOR_LOCAL === "true";
const debugMode = process.env.DEBUG_MODE === "true";

// Only require Smithery API key if not using local MCP
if (!linearApiKey) {
  throw new Error("LINEAR_API_KEY environment variable is not set.");
}

if (!useLocalMcp && !smitheryApiKey) {
  throw new Error(
    "SMITHERY_API_KEY environment variable is not set when not using local MCP."
  );
}

let mcpClient: Client | null = null;
let isConnected = false; // Simplified state flag

const SMITHERY_URL =
  "https://server.smithery.ai/@emmett-deen/linear-mcp-server";

// Function to explicitly mark the client as disconnected
export function markAsDisconnected() {
  console.warn("MCP Client marked as disconnected.");
  isConnected = false;
  mcpClient = null; // Clear the potentially stale client instance
}

async function checkNetworkConnectivity(): Promise<void> {
  console.log("Checking network connectivity...");

  // Simple DNS lookup
  try {
    const { lookup } = await import("dns/promises");
    await lookup("github.com");
    console.log("Network connectivity test passed: DNS lookup successful");
  } catch (error) {
    console.error("Network connectivity issue: DNS lookup failed", error);
  }

  // Simple HTTP request
  try {
    const { request } = await import("https");
    await new Promise<void>((resolve, reject) => {
      const req = request("https://github.com", (res) => {
        console.log(`Network connectivity test: HTTP status ${res.statusCode}`);
        res.on("data", () => {});
        res.on("end", () => resolve());
      });
      req.on("error", (e) => reject(e));
      req.end();
    });
  } catch (error) {
    console.error("Network connectivity issue: HTTP request failed", error);
  }
}

async function initializeMcpClient(): Promise<Client> {
  console.log("Attempting to initialize MCP Client connection...");
  isConnected = false; // Assume not connected until successful
  mcpClient = null; // Clear any old instance

  try {
    if (useLocalMcp) {
      // No Smithery API key needed for local connection
      // Note: createTransport accepts (url, options, key) where key is optional
      const transport = new WebSocketClientTransport(
        createUrl(localMcpUrl, {
          token: linearApiKey,
        })
      );

      console.log("Creating MCP client instance...");

      const client = new Client({
        name: "SlackLinearBotClient",
        version: "1.0.0",
      });

      console.log("Connecting MCP client instance to local server...");
      try {
        await client.connect(transport);
        console.log("MCP Client connect() successful to local server.");
        mcpClient = client;
        isConnected = true;

        const testResult = await mcpClient?.callTool({
          name: McpToolName.SearchIssues,
          arguments: {
            query: `I am unable to click "learn more" on UniswapX info toggle. Expected behavior?`,
          },
        });

        console.log("Test result:", testResult);

        return mcpClient;
      } catch (connectError) {
        console.error(
          "Failed to connect MCP client to local server:",
          connectError
        );
        throw connectError;
      }
    } else {
      console.log("Initializing Smithery MCP transport...");
      const transport = createTransport(
        SMITHERY_URL,
        {
          token: linearApiKey || "",
        },
        smitheryApiKey
      );

      console.log("Creating MCP client instance...");
      const client = new Client({
        name: "SlackLinearBotClient",
        version: "1.0.0",
      });

      console.log("Connecting MCP client instance via Smithery...");
      try {
        await client.connect(transport);
        console.log("MCP Client connect() successful via Smithery.");
        mcpClient = client;
        isConnected = true;
        return mcpClient;
      } catch (connectError) {
        console.error(
          "Failed to connect MCP client via Smithery:",
          connectError
        );
        throw connectError;
      }
    }
  } catch (error) {
    console.error("Failed to initialize or connect MCP client:", error);
    isConnected = false; // Ensure disconnected state on error
    mcpClient = null;
    throw error; // Re-throw the error to indicate failure to the caller
  }
}

export async function getMcpClient(): Promise<Client> {
  if (!isConnected) {
    console.log(
      "getMcpClient: Client not connected, attempting to initialize/reconnect..."
    );
    // Attempt to initialize. If it fails, the error will propagate up.
    await initializeMcpClient();
  }

  // Check if initialization was successful
  if (!mcpClient || !isConnected) {
    throw new Error("MCP Client is not available after attempting connection.");
  }

  console.log("getMcpClient: Returning connected client.");
  return mcpClient;
}

// Optional: Initial connection attempt on module load
initializeMcpClient().catch((error) => {
  console.error("Background MCP client initialization failed:", error);
});
