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
