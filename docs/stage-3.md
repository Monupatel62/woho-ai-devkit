# Stage 3 — Agents

Stage 3 adds the first composable agent runtime on top of @woho/core.

## Current capabilities

- Agent instructions/system prompt
- Named tools with descriptions and optional JSON-schema parameters
- Provider-level tool definitions
- Tool-call responses
- Tool execution and tool-result messages
- Multiple execution steps
- Per-run tool result collection
- Unknown-tool and tool-execution error capture
- Configurable maxSteps safety limit
- OpenAI-compatible tool-call mapping
- Mock provider support for local tool-loop testing

## Execution loop

1. Send the current conversation plus available tool definitions to the AI provider.
2. If the provider returns no tool calls, return the final answer.
3. If tool calls are returned, execute each matching tool.
4. Append assistant tool-call metadata and tool results to the conversation.
5. Send the updated conversation back to the provider.
6. Repeat until a final answer is produced or maxSteps is reached.

The runtime deliberately keeps tool execution outside the model/provider. The model can request a tool, but application code remains responsible for deciding whether and how that tool is executed.

## Next

Build the reusable safe-tool package: calculator, JSON, HTTP, filesystem, search, validation and permission boundaries.
