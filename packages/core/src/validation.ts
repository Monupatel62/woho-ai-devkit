export interface ValidationOptions {
  maxMessages?: number;
  maxMessageCharacters?: number;
  maxTotalCharacters?: number;
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
