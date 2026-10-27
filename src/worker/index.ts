
import { Hono } from 'hono'

type Bindings = {
  TELEGRAM_BOT_TOKEN: string
  TELEGRAM_CHAT_ID: string
}

const app = new Hono<{ Bindings: Bindings }>()

// Existing API
app.get('/api/', (c) => {
  return c.json({ name: 'Cloudflare' })
})

// Send a Telegram message
app.post('/api/telegram', async (c) => {
  const token = c.env.TELEGRAM_BOT_TOKEN
  const chatId = c.env.TELEGRAM_CHAT_ID

  if (!token || !chatId) {
    return c.json({
      ok: false,
      error: 'Missing Telegram configuration'
    }, 503)
  }

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          chat_id: chatId,
          text: '🚀 Hello from my Cloudflare Hono API!'
        })
      }
    )

    return c.json({
      ok: response.ok
    }, response.ok ? 200 : 502)
  } catch {
    return c.json({
      ok: false,
      error: 'Telegram request failed'
    }, 502)
  }
})

export default app
