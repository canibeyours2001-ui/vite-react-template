/** Private-chat Telegram allowlist. Owner is TELEGRAM_CHAT_ID; extras live in D1. */
type D1 = { prepare(sql: string): { bind(...values: (string | number)[]): {
  run(): Promise<{meta:{changes:number}}>
  all<T>(): Promise<{results:T[]}>
}}}
export type AccessEnv = {
  TELEGRAM_CHAT_ID: string
  MEMORY_DB: D1
}
const idPattern = /^[1-9][0-9]{4,15}$/
export async function initAccess(db: D1): Promise<void> {
  await db.prepare(
    'CREATE TABLE IF NOT EXISTS telegram_allowed_users ('+
    'user_id TEXT PRIMARY KEY, added_at INTEGER NOT NULL DEFAULT (unixepoch()))'
  ).bind().run()
}
export async function isAllowedTelegramUser(
  env: AccessEnv, chatId: string, userId: string, chatType?: string
): Promise<boolean> {
  // Never authorize a group: an allowlisted user's presence in a group
  // must not expose private conversation memory or invoke paid models.
  if (chatType && chatType !== 'private') return false
  if (chatId !== userId || !idPattern.test(userId)) return false
  if (userId === env.TELEGRAM_CHAT_ID) return true
  if (!env.MEMORY_DB) return false
  try {
    await initAccess(env.MEMORY_DB)
    const r = await env.MEMORY_DB.prepare(
      'SELECT user_id FROM telegram_allowed_users WHERE user_id=? LIMIT 1'
    ).bind(userId).all<{user_id:string}>()
    return r.results.length > 0
  } catch (e) {
    console.error('Telegram allowlist lookup failed',e instanceof Error?e.name:'unknown')
    return false
  }
}
export function isAccessCommand(text: string): boolean {
  return /^\/(?:allow|deny|allowed|whoami)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text)
}
export async function handleAccessCommand(
  env: AccessEnv, fromId: string, text: string,
  send: (message: string) => Promise<void>
): Promise<boolean> {
  if (!isAccessCommand(text)) return false
  const [word, target] = text.trim().split(/\s+/, 2)
  const cmd = word.toLowerCase().split('@')[0]
  if (cmd === '/whoami') {
    await send('Your Telegram user ID: '+fromId+
      '\nSend this number to the bot owner to request access.')
    return true
  }
  if (fromId !== env.TELEGRAM_CHAT_ID) {
    await send('Only the bot owner can manage the Telegram allowlist.')
    return true
  }
  try {
    await initAccess(env.MEMORY_DB)
    if (cmd === '/allowed') {
      const rows = await env.MEMORY_DB.prepare(
        'SELECT user_id FROM telegram_allowed_users ORDER BY added_at, user_id LIMIT 50'
      ).bind().all<{user_id:string}>()
      const extras = rows.results.map((r,i)=>String(i+1)+'. '+r.user_id)
      await send('Telegram access\nOwner: '+env.TELEGRAM_CHAT_ID+
        '\nAllowed users ('+extras.length+'):\n'+(extras.join('\n')||'None')+
        '\n\nAdd: /allow USER_ID\nRemove: /deny USER_ID')
      return true
    }
    if (!idPattern.test(target||'')) {
      await send('Use /'+(cmd==='/deny'?'deny':'allow')+' USER_ID\n' +
        'Ask the person to send /whoami to this bot for their numeric user ID.')
      return true
    }
    if (target === env.TELEGRAM_CHAT_ID) {
      await send('The owner always has access and cannot be removed.')
      return true
    }
    if (cmd === '/allow') {
      // Limit to 50 additional users to guard against accidental bulk access.
      const total = await env.MEMORY_DB.prepare(
        'SELECT COUNT(*) AS total FROM telegram_allowed_users'
      ).bind().all<{total:number}>()
      const already = await env.MEMORY_DB.prepare(
        'SELECT user_id FROM telegram_allowed_users WHERE user_id=?'
      ).bind(target).all<{user_id:string}>()
      if (!already.results.length && (total.results[0]?.total||0)>=50) {
        await send('Allowlist is full (50 additional users). Remove an ID first.')
        return true
      }
      await env.MEMORY_DB.prepare(
        'INSERT OR IGNORE INTO telegram_allowed_users(user_id) VALUES(?)'
      ).bind(target).run()
      await send('Allowed '+target+'. They can now chat privately with this bot.'+
        '\nNote: allowed users can access configured video/audio generation features.')
    } else if (cmd === '/deny') {
      const result = await env.MEMORY_DB.prepare(
        'DELETE FROM telegram_allowed_users WHERE user_id=?'
      ).bind(target).run()
      await send(result.meta.changes?
        'Removed '+target+' from the allowlist.':
        target+' was not on the allowlist.')
    }
  } catch (e) {
    console.error('Telegram allowlist update failed',e instanceof Error?e.name:'unknown')
    await send('Could not update the allowlist. Check Cloudflare Worker logs.')
  }
  return true
}
