/**
 * MVSEP async separation + scheduled Telegram progress.
 * Qwen is an optional independent GPU backend; no inference on Workers.
 * No additional D1 migration required.
 */
type D1 = {
  prepare(sql: string): {
    bind(...values: (string | number)[]): {
      run(): Promise<{ meta: { changes: number } }>
      all<T>(): Promise<{ results: T[] }>
    }
  }
}
export type AudioEnv = {
  MVSEP_API_TOKEN?: string
  MVSEP_PROXY_KEY?: string
  TELEGRAM_BOT_TOKEN?: string
  MEMORY_DB?: D1
}
type FileInfo = { file_id: string; file_size?: number; file_name?: string; mime_type?: string }
export type AudioMsg = {
  message_id: number
  reply_to_message?: { audio?: FileInfo; voice?: FileInfo; document?: FileInfo }
}
type MvsepResult = {
  success?: boolean
  status?: string
  data?: {
    hash?: string; link?: string; message?: string
    queue_count?: number; current_order?: number
    finished_chunks?: number; all_chunks?: number
    files?: unknown
  }
}
const BASE = 'https://sg.mvsep.com/api'
const LIMIT = 12 * 1024 * 1024
const MODEL = 40

function hashOk(hash: string): boolean {
  return /^[A-Za-z0-9_.-]{6,200}$/.test(hash)
}
async function parseJson(response: Response): Promise<MvsepResult> {
  const result: unknown = await response.json()
  if (typeof result !== 'object' || result === null) throw new Error('Invalid MVSEP response')
  return result as MvsepResult
}
export async function mvsepStatus(hash: string): Promise<MvsepResult> {
  if (!hashOk(hash)) throw new Error('Invalid separation hash')
  const r = await fetch(BASE + '/separation/get?hash=' + encodeURIComponent(hash), {
    signal: AbortSignal.timeout(18000),
  })
  if (!r.ok) throw new Error('MVSEP status HTTP ' + r.status)
  return parseJson(r)
}
export function describeMvsep(result: MvsepResult): string {
  const status = result.status || 'unknown'
  let message = 'MVSEP: ' + status
  const d = result.data
  if (d?.current_order !== undefined) message += '\nQueue position: ' + d.current_order
  if (d?.queue_count !== undefined) message += '\nQueue jobs: ' + d.queue_count
  if (typeof d?.all_chunks === 'number' && d.all_chunks > 0 &&
      typeof d.finished_chunks === 'number') {
    message += '\nChunks: ' + d.finished_chunks + '/' + d.all_chunks
  }
  if (d?.message) message += '\n' + String(d.message).slice(0, 180)
  if (status === 'done') {
    const files = d?.files
    const entries = Array.isArray(files) ? files :
      files && typeof files === 'object' ? Object.values(files) : []
    const links: string[] = []
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue
      const v = entry as Record<string, unknown>
      for (const field of ['url','link','download_url','download']) {
        const raw = v[field]
        if (typeof raw !== 'string') continue
        try {
          const u = new URL(raw)
          if (u.protocol === 'https:' && (u.hostname === 'mvsep.com' || u.hostname.endsWith('.mvsep.com'))) {
            links.push(u.href)
            break
          }
        } catch { /* malformed URL */ }
      }
    }
    if (links.length) message += '\n\n' + links.slice(0, 6).join('\n')
    else if (d?.link) message += '\nResult: ' + d.link
  }
  return message.slice(0, 3900)
}
async function ensureTable(db: D1): Promise<void> {
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS mvsep_live_jobs (" +
    "hash TEXT PRIMARY KEY, chat_id TEXT NOT NULL, status_message_id INTEGER NOT NULL, " +
    "status TEXT NOT NULL DEFAULT 'waiting', " +
    "last_label TEXT NOT NULL DEFAULT '', checked_at INTEGER NOT NULL DEFAULT 0, " +
    "created_at INTEGER NOT NULL DEFAULT (unixepoch()))"
  ).bind().run()
}
async function tgCall(env: AudioEnv, method: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const t = env.TELEGRAM_BOT_TOKEN
  if (!t) throw new Error('Telegram token missing')
  const r = await fetch('https://api.telegram.org/bot' + t + '/' + method, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(16000),
  })
  const data = await r.json() as { ok?: boolean; description?: string; result?: Record<string, unknown> }
  if (!r.ok || !data.ok) throw new Error('Telegram ' + method + ' failed: ' + (data.description || r.status))
  return data.result || {}
}
async function fetchTelegramAudio(env: AudioEnv, file: FileInfo): Promise<Blob> {
  if (!file.file_id || (file.file_size || 0) > LIMIT) throw new Error('Audio exceeds 12 MB')
  const token = env.TELEGRAM_BOT_TOKEN
  if (!token) throw new Error('Missing Telegram token')
  const meta = await fetch('https://api.telegram.org/bot' + token + '/getFile?file_id=' +
    encodeURIComponent(file.file_id), { signal: AbortSignal.timeout(18000) })
  const body = await meta.json() as { ok?: boolean; result?: { file_path?: string; file_size?: number } }
  const path = body.result?.file_path
  if (!meta.ok || !body.ok || !path || path.startsWith('/') || path.includes('..') ||
      (body.result?.file_size || 0) > LIMIT) throw new Error('Invalid Telegram file')
  const fileResponse = await fetch('https://api.telegram.org/file/bot' + token + '/' +
    path.split('/').map(encodeURIComponent).join('/'), { signal: AbortSignal.timeout(30000) })
  if (!fileResponse.ok || Number(fileResponse.headers.get('content-length') || 0) > LIMIT)
    throw new Error('Telegram audio download failed')
  const blob = await fileResponse.blob()
  if (!blob.size || blob.size > LIMIT) throw new Error('Invalid audio file size')
  return blob
}
async function createSeparation(env: AudioEnv, blob: Blob, model: number, name: string): Promise<string> {
  if (!env.MVSEP_API_TOKEN) throw new Error('MVSEP API token missing')
  const f = new FormData()
  f.set('api_token', env.MVSEP_API_TOKEN)
  f.set('sep_type', String(model))
  f.set('output_format', '0')
  f.set('audiofile', blob, name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100))
  const r = await fetch(BASE + '/separation/create', {
    method:'POST',body:f,signal:AbortSignal.timeout(55000),
  })
  const data = await parseJson(r)
  if (!r.ok || !data.success || !data.data?.hash || !hashOk(data.data.hash))
    throw new Error('MVSEP submission failed: ' + String(data.data?.message || r.status).slice(0, 120))
  return data.data.hash
}

export async function handleAudioTelegram(
  env: AudioEnv,
  msg: AudioMsg,
  chatId: string,
  text: string,
  send: (message: string) => Promise<void>
): Promise<boolean> {
  const [raw, arg] = text.trim().split(/\s+/, 2)
  const command = (raw || '').split('@')[0].toLowerCase()
  if (!['/separate','/sep_status','/sep_help','/clone_help','/clone'].includes(command)) return false
  try {
    if (command === '/clone_help' || command === '/clone') {
      await send('Qwen3-TTS voice cloning is available via MVSEP. Use /clone to select a saved or custom voice. Only clone voices you own or have permission to use.')
      return true
    }
    if (command === '/sep_help') {
      await send('MVSEP: send an audio file, REPLY to it with /separate 40. ' +
        'The bot updates a status message every minute. Use /sep_status for the latest status.')
      return true
    }
    if (!env.MEMORY_DB) throw new Error('D1 binding missing')
    await ensureTable(env.MEMORY_DB)
    if (command === '/sep_status') {
      let hash = arg || ''
      if (!hash) {
        const rows = await env.MEMORY_DB.prepare(
          'SELECT hash FROM mvsep_live_jobs WHERE chat_id=? ORDER BY created_at DESC LIMIT 1'
        ).bind(chatId).all<{hash:string}>()
        hash = rows.results[0]?.hash || ''
      }
      if (!hash) { await send('No MVSEP job yet. Reply to an audio file with /separate.'); return true }
      await send(describeMvsep(await mvsepStatus(hash)) + '\nJob: ' + hash)
      return true
    }
    const model = arg ? Number(arg) : MODEL
    if (!Number.isInteger(model) || model < 1 || model > 9999) {
      await send('Invalid MVSEP model number, e.g. /separate 40')
      return true
    }
    const replied = msg.reply_to_message
    const audio = replied?.audio || replied?.voice ||
      (replied?.document && replied.document.mime_type?.startsWith('audio/') ? replied.document : undefined)
    if (!audio) {
      await send('Send an audio file first, then REPLY to it with /separate 40.')
      return true
    }
    const blob = await fetchTelegramAudio(env, audio)
    const hash = await createSeparation(env, blob, model, audio.file_name || 'reference.mp3')
    const statusMessage = await tgCall(env, 'sendMessage', {
      chat_id: chatId, text: 'MVSEP: submitted\nJob: ' + hash + '\nAutomatic updates: every minute',
      reply_parameters: { message_id: msg.message_id },
    })
    const statusId = Number(statusMessage.message_id)
    if (!Number.isInteger(statusId)) throw new Error('Telegram status message ID missing')
    await env.MEMORY_DB.prepare(
      "INSERT OR IGNORE INTO mvsep_live_jobs (hash,chat_id,status_message_id) VALUES (?,?,?)"
    ).bind(hash, chatId, statusId).run()
    return true
  } catch (error) {
    console.error('Audio command failed:', error instanceof Error ? error.name : 'unknown')
    await send('Audio command failed. Check MVSEP account/credits, file size, and Worker logs.')
    return true
  }
}

export async function pollAudioJobs(env: AudioEnv): Promise<void> {
  if (!env.MEMORY_DB || !env.TELEGRAM_BOT_TOKEN) return
  const db = env.MEMORY_DB
  await ensureTable(db)
  const jobs = await db.prepare(
    "SELECT hash, chat_id, status_message_id, last_label FROM mvsep_live_jobs " +
    "WHERE status NOT IN ('done','failed','not_found') AND checked_at < unixepoch()-45 " +
    "AND created_at > unixepoch()-604800 ORDER BY checked_at ASC LIMIT 5"
  ).bind().all<{hash:string;chat_id:string;status_message_id:number;last_label:string}>()
  for (const job of jobs.results) {
    try {
      const status = await mvsepStatus(job.hash)
      const label = describeMvsep(status) + '\nJob: ' + job.hash
      const stage = status.status || 'unknown'
      await db.prepare(
        'UPDATE mvsep_live_jobs SET status=?,last_label=?,checked_at=unixepoch() WHERE hash=?'
      ).bind(stage,label,job.hash).run()
      if (label !== job.last_label) {
        try {
          await tgCall(env,'editMessageText',{
            chat_id:job.chat_id,message_id:job.status_message_id,text:label,
            disable_web_page_preview:true
          })
        } catch (e) {
          console.error('MVSEP Telegram update failed:', e instanceof Error ? e.message.slice(0,100):'unknown')
        }
      }
    } catch (e) {
      console.error('MVSEP poll failed:', e instanceof Error ? e.name : 'unknown')
      await db.prepare('UPDATE mvsep_live_jobs SET checked_at=unixepoch() WHERE hash=?').bind(job.hash).run()
    }
  }
}

