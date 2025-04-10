import { OpenAI } from "openai";
import fs from "node:fs";
import path from "path";
import { McpToolName } from "./enums.js";
import { getMcpClient, markAsDisconnected } from "./mcp_client.js"; // Import MCP client and markAsDisconnected
import util from "util"; // For formatting the output

interface LinearItem {
    title: string;
    url: string;
    status: string;
    assignee?: string;
    metadata: {
        context: {
            description: {
                snippet: string;
            };
        };
    };
}

// Type for an MCP tool
export type McpTool = {
    name: McpToolName;
    description?: string;
    arguments?: any;
};

// Basic result interface for LLM responses
export interface LlmResponse {
    tool: McpTool | null;
    parameters: Record<string, any> | null;
    error?: string;
}

// Define a type for image content
export type ImageContent = {
    type: "input_image";
    image_url: string;
    detail: "auto";
};

// Node types - represent different tasks in the processing pipeline
export enum NodeType {
    PROCESS_IMAGES = "process_images",
    QUERY_LLM = "query_llm",
    LINEAR_SEARCH = "linear_search",
    RATE_MATCHING_TICKETS = "rate_matching_tickets"
}

// Node interface - base for all task nodes
export interface Node<T = any> {
    id: string;
    type: NodeType;
    execute: (context: ExecutionContext) => Promise<T>;
    dependencies?: string[];
}

// Execution context to pass data between nodes
export interface ExecutionContext {
    inputs: Record<string, any>;
    results: Record<string, any>;
    availableTools?: McpTool[];
}

// Image processing node
export interface ProcessImagesNode extends Node<ImageContent[]> {
    type: NodeType.PROCESS_IMAGES;
    files: string[];
}

// LLM query node
export interface QueryLLMNode extends Node<string> {
    type: NodeType.QUERY_LLM;
    prompt: string;
    text: string;
}

// Linear search node
export interface LinearSearchNode extends Node<LlmResponse> {
    type: NodeType.LINEAR_SEARCH;
    query: string;
}

// Rate matching tickets node
export interface RateMatchingTicketsNode extends Node<string> {
    type: NodeType.RATE_MATCHING_TICKETS;
    userMessage: string;
}

// Task pipeline to execute multiple nodes with dependencies
export class TaskPipeline {
    private nodes: Record<string, Node> = {};

    constructor() { }

    addNode(node: Node): string {
        this.nodes[node.id] = node;
        return node.id;
    }

    async execute(initialContext: Partial<ExecutionContext> = {}): Promise<Record<string, any>> {
        const context: ExecutionContext = {
            inputs: {},
            results: {},
            ...(initialContext as any),
        };

        // Determine execution order based on dependencies
        const executionOrder = this.determineExecutionOrder();

        // Execute nodes in order
        for (const nodeId of executionOrder) {
            const node = this.nodes[nodeId];
            try {
                context.results[nodeId] = await node.execute(context);
            } catch (error) {
                console.error(`Error executing node ${nodeId}:`, error);
                throw error;
            }
        }

        return context.results;
    }

    private determineExecutionOrder(): string[] {
        const visited = new Set<string>();
        const executionOrder: string[] = [];

        const visit = (nodeId: string) => {
            if (visited.has(nodeId)) return;

            visited.add(nodeId);

            const node = this.nodes[nodeId];
            if (node.dependencies) {
                for (const depId of node.dependencies) {
                    if (!this.nodes[depId]) {
                        throw new Error(`Dependency "${depId}" not found for node "${nodeId}"`);
                    }
                    visit(depId);
                }
            }

            executionOrder.push(nodeId);
        };

        // Visit all nodes to ensure everything is included
        Object.keys(this.nodes).forEach(visit);

        return executionOrder;
    }
}

// Node implementations

// Process images implementation
export const createProcessImagesNode = (id: string, files: string[]): ProcessImagesNode => {
    return {
        id,
        type: NodeType.PROCESS_IMAGES,
        files,
        async execute(context: ExecutionContext): Promise<ImageContent[]> {
            if (!files.length) return [];

            // Ensure temp directory exists for saving images
            const tempDir = path.join(process.cwd(), 'temp');
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
            }

            // Download and convert images to base64
            const imageContents: ImageContent[] = [];
            for (const fileUrl of files) {
                try {
                    // Generate a unique filename for the image
                    const fileExtension = path.extname(fileUrl) || '.jpg';
                    const fileName = `image_${Date.now()}_${Math.floor(Math.random() * 1000)}${fileExtension}`;
                    const filePath = path.join(tempDir, fileName);

                    console.log(`Downloading image from ${fileUrl}`);
                    // Download the image using fetch
                    const response = await fetch(fileUrl, {
                        headers: {
                            'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`
                        }
                    });

                    // Get the array buffer from the response
                    const arrayBuffer = await response.arrayBuffer();

                    // Save the file locally
                    fs.writeFileSync(filePath, Buffer.from(arrayBuffer));
                    console.log(`Saved image to ${filePath}`);

                    // Read the file and convert to base64
                    const base64Image = fs.readFileSync(filePath, 'base64');

                    // Determine mime type based on file extension
                    const extension = path.extname(fileUrl).toLowerCase();
                    let mimeType = 'image/jpeg'; // Default
                    if (extension === '.png') mimeType = 'image/png';
                    else if (extension === '.gif') mimeType = 'image/gif';
                    else if (extension === '.webp') mimeType = 'image/webp';

                    imageContents.push({
                        type: "input_image" as const,
                        image_url: `data:${mimeType};base64,${base64Image}`,
                        detail: "auto" as const,
                    });
                } catch (error) {
                    console.error(`Error downloading image ${fileUrl}:`, error);
                }
            }

            console.log(`Processed ${imageContents.length} downloaded images`);
            return imageContents;
        },
        dependencies: []
    };
};

// Query LLM implementation
export const createQueryLLMNode = (
    id: string,
    prompt: string,
    text: string,
    dependencies: string[] = [],
    sayFn: (message: string) => Promise<void>
): QueryLLMNode => {
    return {
        id,
        type: NodeType.QUERY_LLM,
        prompt,
        text,
        dependencies,
        async execute(context: ExecutionContext): Promise<string> {
            const llm = new OpenAI({
                apiKey: process.env.OPENAI_API_KEY,
            });

            // Get image contents from previous node if available
            const imageContents = context.results.processImages || [];

            console.log(`Querying LLM with prompt and ${imageContents.length} images`);

            const response = await llm.responses.create({
                model: "gpt-4o-mini",
                input: [
                    {
                        role: "user",
                        content: [
                            { type: "input_text", text: `${this.prompt}\n<message>\n${this.text}\n</message>` },
                            ...imageContents,
                        ],
                    },
                ]
            });

            const formattedResponse = `\`\`\`\n${response.output_text}\n\`\`\``;
            console.log("LLM Response:", formattedResponse);
            await sayFn(formattedResponse);
            return response.output_text;
        }
    };
};

// Linear search node implementation
export const createLinearSearchNode = (
    id: string,
    query: string,
    dependencies: string[] = []
): LinearSearchNode => {
    return {
        id,
        type: NodeType.LINEAR_SEARCH,
        query,
        dependencies,
        async execute(context: ExecutionContext): Promise<LlmResponse> {
            // Get available tools from context
            const availableTools = context.availableTools || [];

            // Find search tool
            const searchTool = availableTools.find(
                (t) => t.name === McpToolName.SearchIssues
            );

            if (searchTool) {
                console.log(`Found ${McpToolName.SearchIssues} tool. Preparing call with query: ${this.query}`);

                try {
                    // Get MCP client
                    const mcpClient = await getMcpClient();

                    // Prepare parameters
                    const parameters = { query: this.query, first: 10 };
                    console.log(`Calling MCP tool: ${searchTool.name} with params:`, parameters);

                    // Call the search tool
                    const result = await mcpClient.callTool({
                        name: searchTool.name,
                        arguments: parameters,
                    });

                    console.log("MCP Tool Call Successful");

                    // Store the search results in the context for later nodes to use
                    context.results.linearSearchResults = result;

                    // Return the response with tool and parameters
                    return {
                        tool: searchTool,
                        parameters: parameters,
                    };
                } catch (error) {
                    console.error("Error calling MCP tool:", error);
                    return {
                        tool: null,
                        parameters: null,
                        error: `Failed to search Linear: ${error instanceof Error ? error.message : String(error)}`
                    };
                }
            }

            // Fallback if search tool isn't available
            console.error(`${McpToolName.SearchIssues} tool not found in available tools!`);
            const errorResult = {
                tool: null,
                parameters: null,
                error: "Linear search tool is currently unavailable.",
            };

            // Store the error result in the context
            context.inputs.linearSearchResult = errorResult;

            return errorResult;
        }
    };
};

// Rate matching tickets node implementation
export const createRateMatchingTicketsNode = (
    id: string,
    userMessage: string,
    dependencies: string[] = [],
    sayFn: (message: string) => Promise<void>
): RateMatchingTicketsNode => {
    return {
        id,
        type: NodeType.RATE_MATCHING_TICKETS,
        userMessage,
        dependencies,
        async execute(context: ExecutionContext): Promise<string> {
            // Get search results from context - first display raw results
            const linearIssues = context.results.linearSearchResults || [];

            // Format and display the raw search results

            const formatSimplifiedResult = (result: any): string => {
                if (!result || !result.content || !Array.isArray(result.content) || !result.content[0]) {
                    return "```\nNo valid data found in result.content\n```";
                }

                const textContent = result.content[0].text;
                let itemsData: LinearItem[];
                try {
                    itemsData = JSON.parse(textContent);
                } catch (error) {
                    return "```\nError parsing content: " + error + "\n```";
                }

                // Limit to 5 items max
                const limitedItems = itemsData.slice(0, 5);

                const formattedItems = limitedItems.map((item: LinearItem) => {
                    const title = item.title ?? "N/A";
                    const description = item.metadata?.context?.description?.snippet ?? "N/A";
                    const url = item.url ?? "N/A";
                    const status = item.status ?? "N/A";
                    const assigneeLine = item.assignee && item.assignee !== "Unassigned"
                        ? `Assignee: ${item.assignee}`
                        : "";

                    const hyperlinkedTitle = url !== "N/A" ? `<${url}|${title}>` : title;

                    return "```\n" + [
                        `Title: ${hyperlinkedTitle}`,
                        `Description: ${description}`,
                        `Status: ${status}`,
                        assigneeLine,
                    ]
                        .filter(line => line)
                        .join("\n") + "\n```";
                });

                return formattedItems.join("\n\n");
            };

            const formattedResult = formatSimplifiedResult(linearIssues);


            await sayFn(`Found potential matches in Linear:\n${formattedResult}`);

            if (!linearIssues || linearIssues.length === 0) {
                const noIssuesMessage = "No matching tickets found to rate.";
                console.log(noIssuesMessage);
                return noIssuesMessage;
            }

            // Read the rating prompt
            const prompt = await fs.promises.readFile("src/prompts/rate_matching_tickets.txt", "utf-8");

            const llm = new OpenAI({
                apiKey: process.env.OPENAI_API_KEY,
            });

            // Get the previous LLM response
            const previousLlmResponse = JSON.parse(context.results.queryLLM);
            const imageDescription = previousLlmResponse?.image_description;

            // Prepare the prompt with user message, previous LLM response, and tickets data
            const ratingPrompt = `${prompt}
                <User message>
                ${this.userMessage}
                </User message>

                <Image description>
                ${imageDescription}
                </Image description>

                <Tickets from Linear>
                ${JSON.stringify(linearIssues.content, null, 2)}
                </Tickets from Linear>`;

            console.log("Querying LLM to rate matching tickets");

            const response = await llm.responses.create({
                model: "gpt-4o-mini",
                input: [
                    {
                        role: "user",
                        content: [
                            { type: "input_text", text: ratingPrompt },
                        ],
                    },
                ]
            });

            const ratingResult = response.output_text;
            const formattedRatingResult = `\`\`\`\n${ratingResult}\n\`\`\``;
            console.log("Rating result:", formattedRatingResult);

            // Send the rating results to the user
            await sayFn(formattedRatingResult);

            return ratingResult;
        }
    };
};

// Main function to process a message with images
export async function processMessageWithLLM(
    text: string,
    availableTools: McpTool[],
    files: string[] = [],
    sayFn: (message: string) => Promise<void>
): Promise<LlmResponse> {
    try {
        console.log("Processing message with LLM pipeline:", text);

        // Create a new pipeline
        const pipeline = new TaskPipeline();

        // Add image processing node if there are files
        const processImagesId = pipeline.addNode(
            createProcessImagesNode("processImages", files)
        );

        // Read the prompt
        const prompt = await fs.promises.readFile("src/prompts/detect_product.txt", "utf-8");

        // Add LLM query node that depends on image processing
        const queryLLMId = pipeline.addNode(
            createQueryLLMNode("queryLLM", prompt, text, [processImagesId], sayFn)
        );

        // Add Linear search node that depends on LLM query
        const linearSearchId = pipeline.addNode(
            createLinearSearchNode("linearSearch", text, [queryLLMId])
        );

        // Add rating node that depends on linear search
        const rateMatchingId = pipeline.addNode(
            createRateMatchingTicketsNode("rateMatching", text, [linearSearchId], sayFn)
        );

        // Execute the pipeline
        const results = await pipeline.execute({ availableTools });

        // Return the linear search result instead of the rating result
        return results[linearSearchId] as LlmResponse;
    } catch (error) {
        console.error("Error in LLM processing pipeline:", error);
        return {
            tool: null,
            parameters: null,
            error: `LLM processing failed: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}
