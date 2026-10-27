import { Hono } from 'hono'

type AIClient = {
  run: (
    model: string,
    input: {
      messages: Array<{ role: 'system' | 'user'; content: string }>
      max_tokens: number
    }
  ) => Promise<{ response?: string }>
}

type Bindings = {
  TELEGRAM_BOT_TOKEN: string
  TELEGRAM_CHAT_ID: string
  AI_ACCESS_KEY: string
  TELEGRAM_WEBHOOK_SECRET: string
  AI: AIClient
}

const app = new Hono<{ Bindings: Bindings }>()

// Keep the original API working
app.get('/api/', (c) => {
  return c.json({ name: 'Cloudflare' })
})

// Keep the original Telegram integration working
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

// Ask Cloudflare Workers AI. Disabled until a private access key is configured.
app.post('/api/ai', async (c) => {
  const configuredKey = c.env.AI_ACCESS_KEY
  if (!configuredKey || configuredKey.length < 24) {
    return c.json({
      ok: false,
      error: 'Set a strong AI_ACCESS_KEY secret in Cloudflare first'
    }, 503)
  }

  const providedKey = c.req.header('X-AI-Access-Key') || ''
  if (providedKey !== configuredKey) {
    return c.json({ ok: false, error: 'Incorrect AI access key' }, 401)
  }

  if (!c.env.AI) {
    return c.json({ ok: false, error: 'Workers AI binding is missing' }, 503)
  }

  let payload: unknown
  try {
    payload = await c.req.json()
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400)
  }

  const prompt =
    typeof payload === 'object' && payload !== null && 'prompt' in payload
      ? (payload as { prompt?: unknown }).prompt
      : undefined

  if (typeof prompt !== 'string' || prompt.trim().length < 1 || prompt.length > 2000) {
    return c.json({
      ok: false,
      error: 'Enter a question between 1 and 2000 characters'
    }, 400)
  }

  try {
    const result = await c.env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8', {
      messages: [
        {
          role: 'system',
          content: 'You are a helpful AI assistant. Answer clearly and concisely. Respond in Burmese if the user asks in Burmese.'
        },
        { role: 'user', content: prompt.trim() }
      ],
      max_tokens: 400
    })

    if (!result || typeof result.response !== 'string') {
      return c.json({ ok: false, error: 'The AI did not return a text answer' }, 502)
    }

    return c.json({ ok: true, answer: result.response })
  } catch {
    return c.json({
      ok: false,
      error: 'AI request failed. Check your Workers AI usage and try again.'
    }, 502)
  }
})

export default app

type TelegramUpdate = {
  message?: {
    chat: { id: number }
    text?: string
    message_id: number
  }
}

app.post('/telegram/webhook', async (c) => {
  const configured = c.env.TELEGRAM_WEBHOOK_SECRET
  if (!configured || c.req.header('X-Telegram-Bot-Api-Secret-Token') !== configured) {
    return c.text('Unauthorized', 401)
  }
  let update: TelegramUpdate
  try { update = await c.req.json<TelegramUpdate>() }
  catch { return c.text('Bad request', 400) }

  const msg = update.message
  if (!msg || String(msg.chat.id) !== c.env.TELEGRAM_CHAT_ID || !msg.text) {
    return c.json({ ok: true })
  }
  const chatId = msg.chat.id
  const token = c.env.TELEGRAM_BOT_TOKEN
  const text = msg.text.trim().slice(0, 2000)
  if (!token || !c.env.AI) return c.json({ ok: false }, 503)

  const processMessage = async () => {
    try {
      const answer = await c.env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8', {
        messages: [
          { role: 'system', content: 'You are a helpful AI Telegram assistant. Answer clearly and briefly. Reply in Burmese when the message is Burmese.' },
          { role: 'user', content: text }
        ],
        max_tokens: 400
      })
      const reply = typeof answer.response === 'string' ? answer.response.slice(0, 3900) : 'No AI response was returned.'
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: reply, reply_parameters: { message_id: msg.message_id } })
      })
    } catch (error) {
      console.error('Telegram AI processing failed', error instanceof Error ? error.message : 'unknown')
    }
  }
  c.executionCtx.waitUntil(processMessage())
  return c.json({ ok: true })
})


async function registerTelegramWebhook(env: Bindings): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN
  const secret = env.TELEGRAM_WEBHOOK_SECRET
  if (!token || !secret) return
  const base = `https://api.telegram.org/bot${token}`
  const statusResp = await fetch(`${base}/getWebhookInfo`)
  const status = await statusResp.json() as { ok: boolean; result?: { url?: string } }
  if (!status.ok) return
  const target = 'https://vite-react-template.canibeyours2001.workers.dev/telegram/webhook'
  // Never replace another bot integration's webhook.
  if (status.result?.url && status.result.url !== target) {
    console.log('Existing Telegram webhook was preserved.')
    return
  }
  if (status.result?.url === target) return
  const response = await fetch(`${base}/setWebhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url: target,
      secret_token: secret,
      allowed_updates: ['message'],
      drop_pending_updates: false
    })
  })
  const data = await response.json() as { ok?: boolean; description?: string }
  console.log('Telegram webhook setup result', data.ok ? 'success' : (data.description || 'failed'))
}

export default {
  fetch: app.fetch,
  async scheduled(_event: unknown, env: Bindings): Promise<void> {
    await registerTelegramWebhook(env)
  }
}
