import { useState } from "react";
import reactLogo from "./assets/react.svg";
import viteLogo from "/vite.svg";
import cloudflareLogo from "./assets/Cloudflare_Logo.svg";
import honoLogo from "./assets/hono.svg";
import "./App.css";

function App() {
  const [count, setCount] = useState(0);
  const [name, setName] = useState("unknown");
  const [sending, setSending] = useState(false);
  const [aiAccessKey, setAiAccessKey] = useState("");
  const [question, setQuestion] = useState("");
  const [aiAnswer, setAiAnswer] = useState("");
  const [aiError, setAiError] = useState("");
  const [askingAI, setAskingAI] = useState(false);

  const getName = async () => {
    try {
      const response = await fetch("/api/");
      if (!response.ok) throw new Error("API request failed");
      const data = (await response.json()) as { name: string };
      setName(data.name);
    } catch {
      alert("Failed to connect to API");
    }
  };

  const sendTelegram = async () => {
    setSending(true);
    try {
      const response = await fetch("/api/telegram", {
        method: "POST",
      });
      const data = (await response.json()) as {
        ok: boolean;
        error?: string;
      };
      alert(
        response.ok && data.ok
          ? "✅ Telegram message sent!"
          : "❌ " + (data.error || "Telegram message failed")
      );
    } catch {
      alert("❌ API connection failed");
    } finally {
      setSending(false);
    }
  };

  const askAI = async () => {
    if (!aiAccessKey || !question.trim()) return;
    setAskingAI(true);
    setAiAnswer("");
    setAiError("");

    try {
      const response = await fetch("/api/ai", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-AI-Access-Key": aiAccessKey,
        },
        body: JSON.stringify({ prompt: question.trim() }),
      });

      const data = (await response.json()) as {
        ok: boolean;
        answer?: string;
        error?: string;
      };

      if (!response.ok || !data.ok) {
        throw new Error(data.error || "AI request failed");
      }

      setAiAnswer(data.answer || "No text returned.");
    } catch (error) {
      setAiError(error instanceof Error ? error.message : "AI request failed");
    } finally {
      setAskingAI(false);
    }
  };

  return (
    <>
      <div>
        <a href="https://vite.dev" target="_blank">
          <img src={viteLogo} className="logo" alt="Vite logo" />
        </a>
        <a href="https://react.dev" target="_blank">
          <img src={reactLogo} className="logo react" alt="React logo" />
        </a>
        <a href="https://hono.dev/" target="_blank">
          <img src={honoLogo} className="logo cloudflare" alt="Hono logo" />
        </a>
        <a href="https://workers.cloudflare.com/" target="_blank">
          <img
            src={cloudflareLogo}
            className="logo cloudflare"
            alt="Cloudflare logo"
          />
        </a>
      </div>

      <h1>Vite + React + Hono + Cloudflare</h1>

      <div className="card">
        <button onClick={() => setCount((current) => current + 1)}>
          count is {count}
        </button>
        <p>My first Cloudflare application!</p>
      </div>

      <div className="card">
        <button onClick={getName}>Name from API is: {name}</button>
        <p>Connected to Cloudflare Hono API</p>
      </div>

      <div className="card">
        <h2>Telegram API Test</h2>
        <p>Click below to send a message through Cloudflare Workers.</p>
        <button onClick={sendTelegram} disabled={sending}>
          {sending ? "Sending..." : "🚀 Send Telegram Message"}
        </button>
      </div>

      <div className="card">
        <h2>Ask Cloudflare AI</h2>
        <p>Llama 3.1 8B — uses your Cloudflare Workers AI free allocation.</p>
        <label htmlFor="ai-key">Private AI access key</label>
        <br />
        <input
          id="ai-key"
          type="password"
          autoComplete="off"
          placeholder="Enter your AI_ACCESS_KEY secret"
          value={aiAccessKey}
          onChange={(event) => setAiAccessKey(event.target.value)}
          style={{ width: "100%", maxWidth: "34rem", boxSizing: "border-box", padding: "0.7rem", margin: "0.5rem 0 1rem" }}
        />
        <br />
        <label htmlFor="ai-question">Your question</label>
        <br />
        <textarea
          id="ai-question"
          placeholder="Ask me something, in English or Burmese..."
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          rows={4}
          maxLength={2000}
          style={{ width: "100%", maxWidth: "34rem", boxSizing: "border-box", padding: "0.7rem", margin: "0.5rem 0 1rem" }}
        />
        <br />
        <button
          onClick={askAI}
          disabled={askingAI || !aiAccessKey || !question.trim()}
        >
          {askingAI ? "Thinking..." : "✨ Ask AI"}
        </button>
        {aiError && <p role="alert">❌ {aiError}</p>}
        {aiAnswer && (
          <div style={{ textAlign: "left", whiteSpace: "pre-wrap", marginTop: "1rem" }}>
            <strong>AI answer:</strong>
            <p>{aiAnswer}</p>
          </div>
        )}
      </div>

      <p className="read-the-docs">
        Powered by Cloudflare Workers + Hono
      </p>
    </>
  );
}

export default App;
