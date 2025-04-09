// Polyfill WebSocket for Node.js environment
import WebSocket from "ws";
if (typeof global.WebSocket === "undefined") {
  (global as any).WebSocket = WebSocket;
}

import { createTransport } from "@smithery/sdk/transport.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import "dotenv/config"; // Ensure environment variables are loaded
import { McpToolName } from "./enums.js";

const linearApiKey = process.env.LINEAR_API_KEY;
const smitheryApiKey = process.env.SMITHERY_API_KEY;

if (!linearApiKey) {
  throw new Error("LINEAR_API_KEY environment variable is not set.");
}

if (!smitheryApiKey) {
  throw new Error("SMITHERY_API_KEY environment variable is not set.");
}

let mcpClient: Client | null = null;
let isConnected = false; // Simplified state flag

const SMITHERY_URL =
  "https://server.smithery.ai/@emmett-deen/linear-mcp-server";
const LOCAL_URL = "http://localhost:3000/mcp";

// Function to explicitly mark the client as disconnected
export function markAsDisconnected() {
  console.warn("MCP Client marked as disconnected.");
  isConnected = false;
  mcpClient = null; // Clear the potentially stale client instance
}

async function initializeMcpClient(): Promise<Client> {
  console.log("Attempting to initialize MCP Client connection...");
  isConnected = false; // Assume not connected until successful
  mcpClient = null; // Clear any old instance

  try {
    console.log("Initializing Smithery MCP transport...");

    const transport = createTransport(
      SMITHERY_URL,
      {
        token: linearApiKey,
      },
      smitheryApiKey
    );

    // Remove event listeners

    console.log("Creating MCP client instance...");
    const client = new Client({
      name: "SlackLinearBotClient",
      version: "1.0.0",
    });

    console.log("Connecting MCP client instance via transport...");
    await client.connect(transport);

    // --- Connection Successful ---
    console.log("MCP Client connect() successful.");
    mcpClient = client;
    isConnected = true; // Set connected state ONLY on full success
    return mcpClient;
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
