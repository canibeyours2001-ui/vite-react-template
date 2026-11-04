# Telegram media recovery — 2026-11-04 (staged; not deployed)

## Kaggle dubbing failure
The most recent Burmese VoxCPM2 dubbing job, Kaggle version 11, ended ERROR, but pyVideoTrans completed a 64.734-second, 31,279,076-byte H.264/AAC MP4. The only fatal exception was "No speech words detected in dubbed audio for karaoke subtitles." FFmpeg showed audible audio at mean -23 dB.

The revised karaoke stage retries without VAD, derives approximate word timings from translated SRT files if available, and keeps the completed MP4 if karaoke alignment or rendering fails. Approximate timings are not forced-alignments.

## HF Wan animation
The latest HF Wan ZeroGPU job failed inside the third-party Space. Its /animate_scene API endpoint is reachable. The existing Modal Wan motion path previously succeeded. The source-backed Wan integration preserves HF2 quota checks and duration selection, adds endpoint preflight, and reports /motion as an explicit alternative; it never silently spends money or switches HF accounts.

## LTX-2.5 with sound
The official Lightricks LTX-2.5 Gradio Space /run endpoint generated a real 1.04-second MP4 with both video and AAC audio in an independent test. Added /ltx, /ltxprobe, and /ltx_status to the Worker source. Generation requires HUGGINGFACE2_API_TOKEN and at least 120 effective free ZeroGPU seconds due to the xlarge reservation.

## Deployment safety
The Cloudflare Worker was independently modified after the GitHub main revision and includes a production-specific Wan overlay. DO NOT deploy this local source bundle over the live Worker until its currently running scripts/assets are reconciled. The new changes are in a separate Git worktree and do not modify the live Worker or main branch. The existing uncommitted Myanmar font changes were preserved in this feature branch.

## Validation
TypeScript compilation, full Vite build, mocked LTX quota/command tests, Wan duration/quota tests (11 cases), and embedded Python syntax checks passed. Fresh end-to-end Kaggle subtitle recovery and real Telegram LTX delivery are not yet verified.

## Existing-MP4 recovery command
Added /dub_recover to the authorized Telegram dubbing commands. For the most recent failed Kaggle version in that chat, this queues an output-only retrieval. The cron reads the existing Kaggle output URL and sends the MP4 through Telegram; it does not POST a new Kaggle kernel push. Status transitions ensure one delivery attempt and avoid duplicate sends when the delivery outcome is ambiguous. If the output URL is unavailable, the bot points the user to Kaggle Outputs. Mock integration checked queued -> delivery -> done, exactly one sendVideo, and no new Kaggle run.

This new command is STAGED ONLY and is not yet available in the production bot.

## Production recovery rollout — 2026-11-04

After the earlier staging note above, a patch was applied **directly to the active Cloudflare Worker bundle**, preserving the production-only Wan ZeroGPU overlay and all 23 bindings. This was NOT a normal deployment from this Git worktree.

- Production v136 (`4f3aeeea-a3b8-4f32-b378-732d1be06294`) fixed Qwen ZeroGPU's Gradio SSE event URL, surfaced sanitized upstream generation errors, and integrated the explicitly invoked LTX-2.5 `/ltx`, `/ltxprobe`, `/ltx_status` handlers using `HUGGINGFACE2_API_TOKEN`.
- Production v137 (`0d605e6e-d77e-4bb9-ae2d-47ac4e449af9`) integrated the karaoke no-VAD and SRT-timing fallbacks, ensured failure of karaoke wouldn't discard the completed MP4, and added a one-shot `/dub_recover` handler/cron using existing Kaggle and Telegram secrets.
- Active v137 verified at 100% with all 23 Cloudflare bindings, original Wan/LTX scheduled handlers and private Telegram webhook HTTP 401 unauthenticated rejection.
- Existing failed dubbing job #10 (Kaggle v13) had a 64.734s H.264/AAC MP4 despite Whisper producing no words. Recovery used the original saved output; `pyvt_kaggle_jobs.status` became `done` at 2026-11-04 12:14:35 UTC after the Telegram sendVideo succeeded. No new Kaggle run was submitted.
- A real new ZeroGPU Qwen generation or new LTX render was NOT submitted after this deploy: these still depend on third-party Space availability and daily HF GPU quota. No automatic resubmission on uncertain generation outcomes.

**Important:** This feature worktree is not yet the byte-for-byte source of production v137. A normal `wrangler deploy` from another checkout could erase the production Wan and other direct-bundle overlays. Reconcile deployed bundle, assets and bindings into source before future standard deployment. Previous immediate rollback target: v136 `4f3aeeea-a3b8-4f32-b378-732d1be06294`.
