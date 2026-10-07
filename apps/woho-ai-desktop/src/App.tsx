import { useState } from "react";

type Message = {
  role: "user" | "assistant";
  content: string;
};

const initialMessages: Message[] = [
  {
    role: "assistant",
    content:
      "Hello! I’m WoHo AI. The desktop foundation is ready. Agent runtime integration comes next.",
  },
];

export function App() {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState("");

  function sendMessage() {
    const value = input.trim();
    if (!value) return;

    setMessages((current) => [
      ...current,
      { role: "user", content: value },
      {
        role: "assistant",
        content:
          "Message received. The @woho/agents execution bridge will handle this in the next integration step.",
      },
    ]);
    setInput("");
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">WoHo AI</div>
        <button className="new-chat" onClick={() => setMessages(initialMessages)}>
          + New Chat
        </button>
        <nav>
          <span>Chats</span>
          <span>Projects</span>
          <span>Files</span>
          <span>Tools</span>
          <span>Agents</span>
        </nav>
        <div className="sidebar-footer">Desktop Foundation · 0.1.0</div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <strong>WoHo AI</strong>
            <small>Local-first agent workspace</small>
          </div>
          <span className="status">Foundation Ready</span>
        </header>

        <div className="messages">
          {messages.map((message, index) => (
            <article key={index} className={message.role}>
              <span className="role">{message.role === "user" ? "You" : "WoHo AI"}</span>
              <p>{message.content}</p>
            </article>
          ))}
        </div>

        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            sendMessage();
          }}
        >
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Ask WoHo AI..."
            aria-label="Ask WoHo AI"
          />
          <button type="submit">Send</button>
        </form>
      </section>
    </main>
  );
}