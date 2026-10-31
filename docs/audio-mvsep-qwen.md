# MVSEP-only audio integration

This project uses the existing Cloudflare Hono Worker, Telegram bot and D1 database. **No new Modal server or GPU is deployed for audio**. The old WAN 2.2 video endpoints remain intact.

## Dependencies and model IDs

- **MVSEP Qwen3-TTS Voice Cloning**: `sep_type=120`
- **MVSEP Qwen3-TTS Voice Design**: `sep_type=119` (API available, no Telegram UI in this release)
- **MVSEP Qwen3-TTS Custom Voice**: `sep_type=118` (API available, no Telegram UI in this release)
- **MVSEP vocal/instrument separation**: `sep_type=26` default
- API base used: `https://sg.mvsep.com/api` (official Singapore region)
- Auth: existing Cloudflare secret `MVSEP_API_TOKEN`

Official reference: https://mvsep.com/en/full_api — Qwen3-TTS (Voice Cloning), model 120, `add_opt2` is optional and omitted when no transcript is provided.

## Save up to five reference voices

1. Send a clear 3–15 sec reference audio/voice recording to your authorized Telegram bot.
2. Reply directly to that recording using:
   `/savevoice 1 Narrator`
3. Repeat with slots 1, 2, 3, 4, and 5 and any short labels you choose.
4. Run `/voices` to see the saved names.

D1 stores the five voice names and Telegram file IDs. It may store optional transcripts for existing profiles, but none are required or prompted for — raw audio is not stored. `getFile` resolves file IDs when generation starts. Replacing a slot updates its existing record.

## Generate voice audio

1. Run `/clone`.
2. Tap one of the five saved voices or **Upload custom voice**.
3. For custom reference audio, upload a recording; no reference transcript is needed.
4. Send your speech as plain text (up to Telegram's 4,096-character per-message limit). For longer scripts, send `/tts_long` after choosing your voice, then send several ordinary Telegram text messages, and finish with `/tts_done`. The bot combines them in Telegram message order, up to a 128 KiB UTF-8 safeguard. MVSEP determines the actual maximum it can generate; it may reject very long input.
5. Tap **Generate audio** to explicitly confirm an MVSEP submission.
6. The existing cron checks status every minute and edits a Telegram status message on changes.
7. On completion, the bot returns an MP3 if MVSEP's URL works with Telegram or a safe MVSEP result link.

`/tts_long` begins plain-text multi-message collection; `/tts_done` finishes the script and displays the normal credit-confirmation buttons. No text-file uploads are supported or needed. `/tts_status` checks your latest Qwen3-TTS job on demand. `/clonelang English` selects a supported language. `/cancel` exits the selection wizard.

The official Qwen3-TTS model does not list Burmese among supported languages. Burmese output is experimental.

Only clone voices you own or have permission to use. MVSEP jobs may consume credits; the bot requires an explicit confirmation and never retries uncertain submissions automatically.

## MVSEP source separation and live status

- Reply to an audio file with `/separate 26`.
- Use `/sep_status` for status and links.
- Status displays queue position, current stage and completed chunks when MVSEP supplies them.
- Uses the same scheduled Worker; no additional server is necessary.

## AI conversation helper

- `/help` or `/commands`: list real commands.
- `/ask Your question`: consult the existing Workers AI assistant.
- Ordinary chat messages also go to AI when outside active voice wizards.
- The AI reads up to 20 Telegram messages already stored in D1 and a sanitized view of voice slots, wizard state, and latest audio/video statuses.
- It does not see other ChatGPT conversations or arbitrary prior Telegram messages.
- The AI gives guidance; paid jobs require the confirmation button.

## Validation and safety

- GitHub Actions type-checks and builds the Vite Hono application.
- Production deployment preserves Cloudflare D1, Workers AI, all secrets, static assets, existing cron and WAN endpoints.
- The scheduled Worker stores a read-only MVSEP account validity check in `mvsep_connection_health`, checking once at most every six hours.
- The bot is restricted to the authorized `TELEGRAM_CHAT_ID` and Telegram webhook secret.
- Voice-profile audio and scripts are sent to MVSEP only on confirmed submission.
- No MVSEP generation was submitted automatically during deployment.

## Installed commands

`/help`, `/commands`, `/ask`, `/clone`, `/clone_help`, `/savevoice`, `/voices`, `/clonelang`, `/tts_long`, `/tts_done`, `/tts_status`, `/cancel`, `/separate`, `/sep_status`, `/sep_help`, plus existing WAN video/motion commands.

## Recovery

Previous Cloudflare deployment version before the MVSEP rollout:
`d3656c5e-7f68-4d9d-80d7-ab599da4ec11`.
Record new deployment versions after each upgrade. GitHub is the source of truth for further changes.

## Telegram owner allowlist

The Worker is restricted to **private chats**. The original `TELEGRAM_CHAT_ID` Cloudflare secret is the permanent owner. Owner alone can manage the additional entries stored in the `telegram_allowed_users` D1 table. Only sender IDs matching their private chat ID are accepted; inline voice-cloning callbacks perform the same check.

- `/whoami`: show your numeric Telegram user ID (also accessible before authorization)
- `/allowed`: owner-only, list additional authorized IDs
- `/allow 123456789`: owner-only, authorize that user ID
- `/deny 123456789`: owner-only, revoke that user ID

Unauthorized users receive no access to saved voice data, AI chat, MVSEP audio, or WAN video. Group chats are not authorized. Do not put the owner ID or additional users' IDs into source control: entries live in the private D1 database. New accounts can message `/whoami` privately to obtain their ID for the owner. Owner access remains available even if the D1 allowlist lookup fails.
