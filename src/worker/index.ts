import { Hono } from 'hono'

type AIClient = {
  run: (
    model: string,
    input: {
      messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
      max_tokens: number
    }
  ) => Promise<{ response?: string }>
}

type Bindings = {
  TELEGRAM_BOT_TOKEN: string
  TELEGRAM_CHAT_ID: string
  AI_ACCESS_KEY: string
  TELEGRAM_WEBHOOK_SECRET: string
  MODAL_WAN_API_BASE?: string
  MODAL_WAN_API_KEY?: string
  AI: AIClient
  MEMORY_DB: {
    prepare: (query: string) => {
      bind: (...params: (string | number)[]) => {
        run: () => Promise<{ meta: { changes: number } }>
        all: <T>() => Promise<{ results: T[] }>
      }
    }
  }
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


type TelegramPhoto = {
  file_id: string
  file_size?: number
  width?: number
  height?: number
}

type TelegramUpdate = {
  message?: {
    chat: { id: number }
    text?: string
    caption?: string
    photo?: TelegramPhoto[]
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
  if (!msg || String(msg.chat.id) !== c.env.TELEGRAM_CHAT_ID || (!msg.text && !msg.caption && !msg.photo?.length)) {
    return c.json({ ok: true })
  }
  const chatId = msg.chat.id
  const token = c.env.TELEGRAM_BOT_TOKEN
  const text = (msg.text ?? msg.caption ?? '').trim().slice(0, 2000)
  if (!token || !c.env.AI) return c.json({ ok: false }, 503)

  const processMessage = async () => {
    const db = c.env.MEMORY_DB
    if (!db) {
      console.error('Telegram memory binding missing')
      return
    }
    const key = String(chatId)
    const send = async (reply: string) => {
      const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: reply.slice(0, 3900),
          reply_parameters: { message_id: msg.message_id }
        })
      })
      if (!resp.ok) throw new Error('Telegram send failed')
    }
    // Fetch an existing video only after Modal confirms its job succeeded.
    // This does not start generation or invoke the GPU worker.
    const sendCompletedVideo = async (jobId: string, headers: Record<string, string>, base: string): Promise<void> => {
      if (!/^[a-f0-9]{32}$/.test(jobId)) throw new Error('Invalid video job ID')
      const media = await fetch(base + '/v1/generations/' + jobId + '/video', {
        headers,
        signal: AbortSignal.timeout(30000)
      })
      if (!media.ok) throw new Error('Modal video HTTP ' + media.status)
      const announcedSize = Number(media.headers.get('content-length') || 0)
      const maxSize = 45 * 1024 * 1024 // Below Telegram Bot API upload limits.
      if (announcedSize > maxSize) { await media.body?.cancel(); throw new Error('Video exceeds Telegram upload limit') }
      const blob = await media.blob()
      if (!blob.size || blob.size > maxSize) throw new Error('Video is empty or too large')
      const form = new FormData()
      form.set('chat_id', key)
      form.set('caption', 'Wan 2.2 video completed.\nJob ID: ' + jobId)
      form.set('video', blob, jobId + '.mp4')
      const sent = await fetch('https://api.telegram.org/bot' + token + '/sendVideo', {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(30000)
      })
      if (!sent.ok) throw new Error('Telegram sendVideo HTTP ' + sent.status)
    }
    try {
      if (text.toLowerCase() === '/forget' || text.toLowerCase() === '/reset') {
        await db.prepare('DELETE FROM messages WHERE chat_id = ?').bind(key).run()
        await send('Conversation memory cleared. We can start fresh.')
        return
      }
      if (text === '/start') {
        await send('Hello! I can remember our recent conversation. Send /forget to clear my memory.')
        return
      }
      // Video commands use a separate job table and do not enter AI chat memory.
      if (text === '/video' || text === '/video_help') {
        await send('Text to video: /video your prompt\nImage to video: attach a Telegram photo with caption /image2video your motion prompt\nCheck progress and receive video: /video_status\nRetrieve an existing video: /video_get JOB_ID')
        return
      }
      if (text.startsWith('/video_get ')) {
        const jobId = text.slice('/video_get '.length).trim()
        if (!/^[a-f0-9]{32}$/.test(jobId)) {
          await send('Invalid video ID. Use /video_get followed by the 32-character Modal job ID.')
          return
        }
        if (!c.env.MODAL_WAN_API_BASE || !c.env.MODAL_WAN_API_KEY) {
          await send('Modal video API is not configured.')
          return
        }
        const base = c.env.MODAL_WAN_API_BASE.replace(/\/$/, '')
        const headers = { Authorization: 'Bearer ' + c.env.MODAL_WAN_API_KEY }
        try {
          const response = await fetch(base + '/v1/generations/' + jobId, {
            headers, signal: AbortSignal.timeout(12000)
          })
          if (!response.ok) throw new Error('Modal status HTTP ' + response.status)
          const data: unknown = await response.json()
          const status = typeof data === 'object' && data !== null && 'status' in data ? String(data.status) : 'unknown'
          if (status !== 'succeeded') {
            await send('Video status: ' + status + '\nJob ID: ' + jobId)
            return
          }
          await sendCompletedVideo(jobId, headers, base)
        } catch (error) {
          console.error('Modal video delivery failed', error instanceof Error ? error.message : 'unknown')
          await send('Could not deliver that video. Confirm its Modal job succeeded and try again.')
        }
        return
      }
      if (text === '/video_status') {
        const jobs = await db.prepare(
          'SELECT job_id, status FROM wan_video_jobs WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1'
        ).bind(key).all<{ job_id: string; status: string }>()
        const latest = jobs.results[0]
        if (!latest) { await send('No video job has been submitted yet.'); return }
        if (!c.env.MODAL_WAN_API_BASE || !latest.job_id) {
          await send('Latest video job status: ' + latest.status)
          return
        }
        try {
          const base = c.env.MODAL_WAN_API_BASE.replace(/\/$/, '')
          const headers: Record<string, string> = {}
          if (c.env.MODAL_WAN_API_KEY) headers.Authorization = 'Bearer ' + c.env.MODAL_WAN_API_KEY
          const response = await fetch(base + '/v1/generations/' + encodeURIComponent(latest.job_id), { headers, signal: AbortSignal.timeout(12000) })
          if (!response.ok) throw new Error('status ' + response.status)
          const data: unknown = await response.json()
          const status = typeof data === 'object' && data !== null && 'status' in data ? String(data.status) : 'unknown'
          await db.prepare('UPDATE wan_video_jobs SET status = ?, updated_at = unixepoch() WHERE chat_id = ? AND job_id = ?').bind(status,key,latest.job_id).run()
          if (status === 'succeeded') {
            await send('Video status: succeeded. Delivering MP4 to this chat.')
            try {
              await sendCompletedVideo(latest.job_id, headers, base)
            } catch (error) {
              console.error('Modal video delivery failed', error instanceof Error ? error.message : 'unknown')
              await send('Video succeeded, but Telegram delivery failed. Retry /video_status or use /video_get ' + latest.job_id)
            }
          } else {
            await send('Video status: ' + status + '\nJob ID: ' + latest.job_id)
          }
        } catch {
          await send('Could not retrieve Modal job status. Check your endpoint availability and API format.')
        }
        return
      }
      if (text === '/image2video' || text === '/image2video_help') {
        await send('Attach a photo and set its caption to: /image2video A slow cinematic push-in, gentle wind moving the hair')
        return
      }
      if (msg.photo?.length && !text.startsWith('/image2video ') && !text.startsWith('/video ')) {
        await send('Photo received. To animate it, send the photo again with caption: /image2video your motion prompt')
        return
      }
      if (text.startsWith('/video ') || text.startsWith('/image2video ')) {
        const isImageCommand = text.startsWith('/image2video ')
        const prompt = text.slice(isImageCommand ? '/image2video '.length : '/video '.length).trim()
        if (!prompt || prompt.length > 1500) { await send('Please provide a video prompt of 1–1500 characters.'); return }
        if (isImageCommand && !msg.photo?.length) {
          await send('Image-to-video needs a photo. Attach a photo with the caption: /image2video ' + prompt)
          return
        }
        const baseValue = c.env.MODAL_WAN_API_BASE
        if (!baseValue) {
          await send('Modal WAN endpoint is not configured yet. Video generation is disabled; ordinary AI chat still works.')
          return
        }
        let base: URL
        try {
          base = new URL(baseValue)
          if (base.protocol !== 'https:' || !base.hostname.endsWith('.modal.run') || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
            throw new Error('Invalid endpoint')
          }
        } catch {
          await send('Modal endpoint configuration is invalid. Use the HTTPS .modal.run service base URL.')
          return
        }
        const inserted = await db.prepare(
          "INSERT OR IGNORE INTO wan_video_jobs (chat_id,telegram_message_id,status) VALUES (?,?,'submitting')"
        ).bind(key,msg.message_id).run()
        if (inserted.meta.changes === 0) return
        try {
          // Modal's FastAPI route uses Form(...) fields, not a JSON body.
          const form = new FormData()
          form.set('prompt', prompt)
          form.set('width', '1280')
          form.set('height', '704')
          form.set('seed', '-1')
          if (msg.photo?.length) {
            // Telegram compresses photos to JPEG. Select a suitable variant.
            const maximumImageBytes = 4 * 1024 * 1024
            const candidates = [...msg.photo].filter(p => !p.file_size || p.file_size <= maximumImageBytes)
            const photo = candidates.sort((a, b) => (a.file_size || 0) - (b.file_size || 0)).at(-1)
            if (!photo) throw new Error('Photo exceeds the 4 MB image-upload limit')
            const infoResponse = await fetch(
              'https://api.telegram.org/bot' + token + '/getFile?file_id=' + encodeURIComponent(photo.file_id),
              { signal: AbortSignal.timeout(10000) }
            )
            if (!infoResponse.ok) throw new Error('Telegram image lookup failed')
            const info = await infoResponse.json() as {
              ok: boolean
              result?: { file_path?: string; file_size?: number }
            }
            const filePath = info.result?.file_path
            if (!info.ok || !filePath || filePath.includes('..') || filePath.startsWith('/')) {
              throw new Error('Telegram image location unavailable')
            }
            if ((info.result?.file_size || 0) > maximumImageBytes) throw new Error('Photo exceeds the 4 MB image-upload limit')
            const photoResponse = await fetch(
              'https://api.telegram.org/file/bot' + token + '/' + filePath,
              { signal: AbortSignal.timeout(15000) }
            )
            if (!photoResponse.ok) throw new Error('Telegram photo download failed')
            const imageBytes = await photoResponse.arrayBuffer()
            if (!imageBytes.byteLength || imageBytes.byteLength > maximumImageBytes) {
              throw new Error('Photo is empty or exceeds the 4 MB image-upload limit')
            }
            form.set('image', new Blob([imageBytes], { type: 'image/jpeg' }), 'telegram-photo.jpg')
          }
          const headers: Record<string,string> = {}
          if (c.env.MODAL_WAN_API_KEY) headers.Authorization = 'Bearer ' + c.env.MODAL_WAN_API_KEY
          // fetch() sets the multipart boundary automatically. Do not set Content-Type.
          const response = await fetch(base.toString().replace(/\/$/, '') + '/v1/generations', {
            method: 'POST',
            headers,
            body: form,
            signal: AbortSignal.timeout(20000)
          })
          if (!response.ok) {
            if (response.status === 422) {
              let description = 'Request parameters were rejected'
              try {
                const details: unknown = await response.json()
                if (typeof details === 'object' && details !== null && 'detail' in details) {
                  const errors = (details as { detail?: unknown }).detail
                  if (Array.isArray(errors)) {
                    const entries = errors.slice(0, 6).map((item: unknown) => {
                      if (typeof item !== 'object' || item === null) return 'Invalid parameter'
                      const entry = item as { loc?: unknown; msg?: unknown }
                      const loc = Array.isArray(entry.loc)
                        ? entry.loc.map(String).join('.')
                        : 'request'
                      const msg = typeof entry.msg === 'string' ? entry.msg : 'Invalid parameter'
                      return loc.slice(0, 100) + ': ' + msg.slice(0, 180)
                    })
                    description = entries.join('; ') || description
                  } else if (typeof errors === 'string') {
                    description = errors.slice(0, 500)
                  }
                }
              } catch {
                // Avoid exposing upstream response bodies or credentials.
              }
              throw new Error('Modal HTTP 422: ' + description)
            }
            throw new Error('Modal HTTP ' + response.status)
          }
          const data: unknown = await response.json()
          const obj = typeof data === 'object' && data !== null ? data as Record<string,unknown> : {}
          const jobId = typeof obj.id === 'string' ? obj.id : typeof obj.job_id === 'string' ? obj.job_id : ''
          const status = typeof obj.status === 'string' ? obj.status : 'submitted'
          if (!jobId) throw new Error('Missing job identifier')
          await db.prepare('UPDATE wan_video_jobs SET job_id = ?, status = ?, updated_at = unixepoch() WHERE chat_id = ? AND telegram_message_id = ?')
            .bind(jobId,status,key,msg.message_id).run()
          await send((msg.photo?.length ? 'Wan 2.2 image-to-video submitted.' : 'Wan 2.2 text-to-video submitted.') + '\nJob ID: ' + jobId + '\nUse /video_status to check progress.')
        } catch (error) {
          await db.prepare("UPDATE wan_video_jobs SET status = 'failed', updated_at = unixepoch() WHERE chat_id = ? AND telegram_message_id = ?").bind(key,msg.message_id).run()
          console.error('Modal job request failed',error instanceof Error ? error.message : 'unknown')
          const reason = error instanceof Error ? error.message : 'Unknown error'
          const safeReason = reason.startsWith('Modal HTTP ')
            ? reason.slice(0, 900)
            : 'A connection or response-format error occurred'
          await send('Video job rejected. ' + safeReason + '\nNo successful job was confirmed.')
        }
        return
      }
      // Delete old messages for this chat after 7 days.
      await db.prepare("DELETE FROM messages WHERE chat_id = ? AND created_at < unixepoch() - 604800").bind(key).run()

      // Store once per Telegram message, avoiding duplicate processing on retries.
      const inserted = await db.prepare(
        "INSERT OR IGNORE INTO messages (chat_id, message_id, role, content) VALUES (?, ?, 'user', ?)"
      ).bind(key, msg.message_id, text).run()
      if (inserted.meta.changes === 0) return

      const records = await db.prepare(
        "SELECT role, content FROM messages WHERE chat_id = ? AND (message_id < ? OR (message_id = ? AND role = 'user')) ORDER BY message_id DESC, role ASC LIMIT 20"
      ).bind(key, msg.message_id, msg.message_id).all<{ role: 'user' | 'assistant'; content: string }>()
      const history = records.results.reverse().map(row => ({
        role: row.role,
        content: row.content
      }))
      const answer = await c.env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8', {
        messages: [
          {
            role: 'system',
            content: 'You are a helpful English-only AI Telegram assistant. Respond only in English, regardless of the language used. Use recent conversation messages to understand follow-up questions. Be clear, accurate, and concise. If context is missing, ask for clarification.'
          },
          ...history
        ],
        max_tokens: 400
      })
      const reply = typeof answer.response === 'string' && answer.response.trim()
        ? answer.response.trim().slice(0, 3900)
        : 'I could not produce an answer. Please try asking again.'
      await send(reply)
      await db.prepare(
        "INSERT OR REPLACE INTO messages (chat_id, message_id, role, content) VALUES (?, ?, 'assistant', ?)"
      ).bind(key, msg.message_id, reply).run()
      // Keep at most 20 recent messages per chat.
      await db.prepare(
        'DELETE FROM messages WHERE chat_id = ? AND rowid NOT IN (SELECT rowid FROM messages WHERE chat_id = ? ORDER BY message_id DESC, role ASC LIMIT 20)'
      ).bind(key, key).run()
    } catch (error) {
      console.error('Telegram memory processing failed', error instanceof Error ? error.message : 'unknown')
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
