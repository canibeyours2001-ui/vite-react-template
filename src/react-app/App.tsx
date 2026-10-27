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

      <p className="read-the-docs">
        Powered by Cloudflare Workers + Hono
      </p>
    </>
  );
}

export default App;
