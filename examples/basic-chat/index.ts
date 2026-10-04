import { createAI } from "@woho/core";
import { createOpenAIProvider } from "@woho/provider-openai";

const ai = createAI({
  provider: createOpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY ?? "",
  }),
});

const result = await ai.chat({
  messages: [{ role: "user", content: "Say hello from WoHo AI DevKit." }],
});

console.log(result.text);