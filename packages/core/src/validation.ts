import type { AIRequest } from "./types.js";

export interface ValidationOptions {
  maxMessages?: number;
  maxMessageCharacters?: number;
  maxTotalCharacters?: number;
  maxToolDefinitions?: number;
  maxToolDefinitionBytes?: number;
  maxToolCallsPerMessage?: number;
  maxToolArgumentBytes?: number;
  maxStopSequences?: number;
  maxStopSequenceCharacters?: number;
  maxStopSequenceTotalCharacters?: number;
}

export function validateAIInput(messages: readonly { content: string }[], options: ValidationOptions = {}): void {
  const maxMessages = options.maxMessages ?? 100;
  const maxMessageCharacters = options.maxMessageCharacters ?? 100_000;
  const maxTotalCharacters = options.maxTotalCharacters ?? 500_000;
  if (!Number.isInteger(maxMessages) || maxMessages < 1) throw new Error("maxMessages must be a positive integer");
  if (!Number.isInteger(maxMessageCharacters) || maxMessageCharacters < 1) throw new Error("maxMessageCharacters must be a positive integer");
  if (!Number.isInteger(maxTotalCharacters) || maxTotalCharacters < 1) throw new Error("maxTotalCharacters must be a positive integer");
  if (messages.length > maxMessages) throw new Error("AI request exceeds maxMessages");
  let total = 0;
  for (const message of messages) {
    if (typeof message.content !== "string") throw new Error("AI message content must be a string");
    if (message.content.length > maxMessageCharacters) throw new Error("AI message exceeds maxMessageCharacters");
    total += message.content.length;
    if (total > maxTotalCharacters) throw new Error("AI request exceeds maxTotalCharacters");
  }
}

export function validateAIRequest(request: AIRequest, options: ValidationOptions = {}): void {
  if (!request || typeof request !== "object") throw new Error("AI request is required");
  validateAIInput(request.messages, options);

  const maxToolDefinitions = options.maxToolDefinitions ?? 64;
  const maxToolDefinitionBytes = options.maxToolDefinitionBytes ?? 256 * 1024;
  const maxToolCallsPerMessage = options.maxToolCallsPerMessage ?? 32;
  const maxToolArgumentBytes = options.maxToolArgumentBytes ?? 256 * 1024;
  const maxStopSequences = options.maxStopSequences ?? 16;
  const maxStopSequenceCharacters = options.maxStopSequenceCharacters ?? 4096;
  const maxStopSequenceTotalCharacters = options.maxStopSequenceTotalCharacters ?? 16 * 1024;

  if (!Number.isInteger(maxToolDefinitions) || maxToolDefinitions < 1) throw new Error("maxToolDefinitions must be a positive integer");
  if (!Number.isInteger(maxToolDefinitionBytes) || maxToolDefinitionBytes < 1) throw new Error("maxToolDefinitionBytes must be a positive integer");
  if (!Number.isInteger(maxToolCallsPerMessage) || maxToolCallsPerMessage < 1) throw new Error("maxToolCallsPerMessage must be a positive integer");
  if (!Number.isInteger(maxToolArgumentBytes) || maxToolArgumentBytes < 1) throw new Error("maxToolArgumentBytes must be a positive integer");
  if (!Number.isInteger(maxStopSequences) || maxStopSequences < 1) throw new Error("maxStopSequences must be a positive integer");
  if (!Number.isInteger(maxStopSequenceCharacters) || maxStopSequenceCharacters < 1) throw new Error("maxStopSequenceCharacters must be a positive integer");
  if (!Number.isInteger(maxStopSequenceTotalCharacters) || maxStopSequenceTotalCharacters < 1) throw new Error("maxStopSequenceTotalCharacters must be a positive integer");

  if (request.temperature !== undefined && (!Number.isFinite(request.temperature) || request.temperature < 0 || request.temperature > 2)) {
    throw new Error("temperature must be a finite number between 0 and 2");
  }
  if (request.topP !== undefined && (!Number.isFinite(request.topP) || request.topP <= 0 || request.topP > 1)) {
    throw new Error("topP must be a finite number greater than 0 and at most 1");
  }
  if (request.maxTokens !== undefined && (!Number.isInteger(request.maxTokens) || request.maxTokens < 1)) {
    throw new Error("maxTokens must be a positive integer");
  }
  if (request.stop !== undefined) {
    if (!Array.isArray(request.stop)) throw new Error("stop must be an array");
    if (request.stop.length > maxStopSequences) throw new Error("AI request exceeds maxStopSequences");
    let stopTotal = 0;
    for (const sequence of request.stop) {
      if (typeof sequence !== "string") throw new Error("stop sequences must be strings");
      if (sequence.length > maxStopSequenceCharacters) throw new Error("AI stop sequence exceeds maxStopSequenceCharacters");
      stopTotal += sequence.length;
      if (stopTotal > maxStopSequenceTotalCharacters) throw new Error("AI request exceeds maxStopSequenceTotalCharacters");
    }
  }

  if (request.tools && request.tools.length > maxToolDefinitions) throw new Error("AI request exceeds maxToolDefinitions");
  if (request.tools) {
    let toolBytes = 0;
    for (const tool of request.tools) {
      if (!tool || typeof tool !== "object" || typeof tool.name !== "string" || typeof tool.description !== "string") {
        throw new Error("AI tool definition is invalid");
      }
      if (!tool.name.trim()) throw new Error("AI tool name is required");
      toolBytes += Buffer.byteLength(JSON.stringify(tool), "utf8");
      if (toolBytes > maxToolDefinitionBytes) throw new Error("AI request exceeds maxToolDefinitionBytes");
    }
  }

  for (const message of request.messages) {
    if (!message || typeof message !== "object") throw new Error("AI message is invalid");
    if (message.toolCalls && message.toolCalls.length > maxToolCallsPerMessage) throw new Error("AI message exceeds maxToolCallsPerMessage");
    for (const call of message.toolCalls ?? []) {
      if (!call || typeof call !== "object" || typeof call.arguments !== "string") throw new Error("AI tool call is invalid");
      if (Buffer.byteLength(call.arguments, "utf8") > maxToolArgumentBytes) throw new Error("AI tool call exceeds maxToolArgumentBytes");
    }
  }
}
