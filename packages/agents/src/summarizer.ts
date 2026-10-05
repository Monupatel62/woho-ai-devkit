import type { AIClient } from "@woho/core";
import type { MemoryMessage, MemorySummarizer } from "@woho/memory";

export interface AISummarizerOptions {
  instruction?: string;
}

export function createAISummarizer(ai: AIClient, options: AISummarizerOptions = {}): MemorySummarizer {
  const instruction = options.instruction ?? "Summarize the conversation memory accurately. Preserve important facts, decisions, tasks, constraints, and unresolved questions. Do not invent information.";
  return {
    async summarize(messages: MemoryMessage[], limits = {}) {
      if (!messages.length) return "";
      const response = await ai.chat({
        messages: [
          { role: "system", content: instruction },
          { role: "user", content: messages.map((m) => m.role + ": " + m.content).join("\n") },
        ],
      });
      const text = response.text.trim();
      return limits.maxCharacters ? text.slice(0, limits.maxCharacters) : text;
    },
  };
}
