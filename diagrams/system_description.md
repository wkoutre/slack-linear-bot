# Slack Linear Bot - System Architecture

## Overview

The Slack Linear Bot is a integration tool that connects Slack with Linear (issue tracking system). It helps users find and manage Linear issues directly from Slack conversations. The bot uses AI (OpenAI) to analyze user messages, understand context from both text and images, and find relevant Linear tickets.

## Core Components

### External Systems

1. **Slack** - Messaging platform where users interact with the bot
2. **OpenAI API** - Provides AI capabilities for analyzing messages and matching tickets
3. **Linear** - Issue tracking system that stores tickets/issues

### Internal Components

1. **Slack Bot (app.ts)** - Main application entry point that handles Slack events and user interactions
2. **Task Pipeline** - Orchestrates the execution of different processing nodes
3. **MCP Client** - Model Context Protocol client that manages communication with Linear

### Processing Nodes

1. **Process Images Node** - Downloads and processes images from Slack messages
2. **Query LLM Node** - Analyzes user messages using OpenAI to understand context
3. **Linear Search Node** - Searches Linear for relevant issues
4. **Rate Matching Tickets Node** - Rates how well Linear tickets match the user's query

## User Flow

1. User posts a message (with optional images) in Slack
2. Bot responds with welcome message and action buttons
3. User clicks "Find related Linear issues"
4. Bot analyzes the message:
   - Processes any attached images
   - Queries OpenAI to understand message context
   - Displays analysis results with confidence level
   - Waits for user confirmation
5. User confirms the analysis
6. Bot searches Linear for related issues
7. Bot uses OpenAI to rate matching tickets by relevance
8. Bot displays rated tickets to the user

## Technical Implementation

### Task Pipeline

The system uses a custom task pipeline architecture where:

- Each task is represented as a node with dependencies
- Nodes execute in dependency order
- Results from each node are passed to dependent nodes
- The pipeline handles orchestration and error management

### Slack Integration

- Uses Slack Bolt.js SDK
- Handles message events, button clicks, and interactive elements
- Manages thread-based conversations

### AI Integration

- Uses OpenAI API for:
  - Analyzing user messages and images
  - Understanding product context (Web/Mobile/Extension)
  - Rating ticket relevance

### Linear Integration

- Uses MCP (Model Context Protocol) client
- Provides tools for searching and managing Linear issues
- Supports multiple Linear operations (search, create, update)

## State Management

- In-memory state tracking for user conversations
- Thread-based context tracking for multi-message interactions
- Edit mode for allowing users to refine their queries
