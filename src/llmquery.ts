import { OpenAI } from "openai";
import fs from "node:fs";
import path from "path";
import { McpToolName } from "./enums.js";

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
    LINEAR_SEARCH = "linear_search"
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
    model?: string;
}

// Linear search node
export interface LinearSearchNode extends Node<LlmResponse> {
    type: NodeType.LINEAR_SEARCH;
    query: string;
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
            context.inputs.imageContents = imageContents;

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
        model: "gpt-4o-mini",
        dependencies,
        async execute(context: ExecutionContext): Promise<string> {
            const llm = new OpenAI({
                apiKey: process.env.OPENAI_API_KEY,
            });

            // Get image contents from previous node if available
            const imageContents = context.inputs.imageContents || [];

            console.log(`Querying LLM with prompt and ${imageContents.length} images`);

            const response = await llm.responses.create({
                model: this.model as "gpt-4o-mini",
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

            console.log("LLM Response:", response.output_text);
            await sayFn(response.output_text);
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
                return {
                    tool: searchTool,
                    parameters: { query: this.query },
                };
            }

            // Fallback if search tool isn't available
            console.error(`${McpToolName.SearchIssues} tool not found in available tools!`);
            return {
                tool: null,
                parameters: null,
                error: "Linear search tool is currently unavailable.",
            };
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

        // Execute the pipeline
        const results = await pipeline.execute({ availableTools });

        // Return the linear search result
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
