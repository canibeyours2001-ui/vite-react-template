# HF2 ZeroGPU quota and Wan Animate — production overlay

Status (2026-11-04): Deployed to Cloudflare Worker `vite-react-template`.

## Existing production implementation

- **Current version**: `5bf05e79-6458-4585-ab09-c4824e823687` (100%).
- **Current deployment**: `50ea31e8-379a-4562-8fdb-d8d3ffe873ee`.
- **Previous known-good version**: `38199884-d349-494c-81c2-c75eeec58945` (rollback target).
- The live Worker uses `HUGGINGFACE2_API_TOKEN` for the new ZeroGPU commands.
- Existing 23 Cloudflare bindings, Worker asset bundle, Telegram webhook handler, and D1 resource retained. The new features wrap the original Worker entrypoint rather than replacing existing routes.
- New commands: `/gpuquota`, `/wananimate`, `/wan_status`, registered in the native Telegram menu.
- New D1 table: `hf_wan22_jobs`. Existing Wan Modal and dubbing commands are unchanged.

## Operator notes

`deploy/hf2-gpuquota-wan-production-overlay.js` is the **exact JS logic appended to the production Cloudflare bundle** before the existing worker export. It is not a directly executable Worker by itself. Prior to any future normal Wrangler or GitHub deployment, integrate it properly into `src/worker/index.ts` as an import or equivalent. Do not blindly upload this older branch's app bundle over the current production Worker: production had newer dashboard changes than the Git checkout.

The overlay changes the exported Worker entrypoint to call `hfWanIntercept` before the existing `index.fetch` and to run `hfWanScheduled` alongside the original `index.scheduled`. All previously deployed entrypoints were preserved.

The deployment has been verified for bindings, Cloudflare build validation, 100% production rollout, Telegram webhook secret rejection, and D1 table initialization. Command behavior was unit-tested with mock quota/Telegram/Gradio responses. An authenticated real `/gpuquota` reply and a real 2-second user-input render have **not** yet been tested; do not report these as verified.

## HF quota safety

The quota endpoint is `GET https://huggingface.co/api/spaces/zero-gpu/quota`. A Hugging Face token may need Billing Read permission for the API. This integration uses the token 2 binding directly and refuses Wan GPU submissions when the remaining quota is below 195 seconds. It does not switch accounts, retry uncertain generation submissions, or consume paid over-quota credits intentionally. Hugging Face usage quotas are per account, not per API token.

## Rollback

The previous production version ID above can be redeployed using Cloudflare Workers > Deployments > select version, or the Workers deployments API with 100% traffic to that version. The new D1 table is additive and may be left intact.

## Wan automatic duration upgrade (2026-11-04)

`/wananimate` now selects **5–10 seconds** without a duration argument, using the Telegram driving video duration and available HF2 account ZeroGPU quota. For video files uploaded as Telegram documents, duration metadata may be absent; the safe default is 5 seconds. Videos shorter than five seconds are rejected when duration metadata is present.

For Low Res Character Swap, the Space's current declared GPU reservations are: 5s = 150 GPU-seconds, 6s = 210, 7s = 220, 8s = 260, 9s = 270, 10s = 270. The queue selects the maximum affordable duration not longer than the input. At submission it rechecks quota and may downgrade without retrying any generation. Quota availability and upstream Space behavior may change.

An additive D1 schema change adds `duration_s INTEGER NOT NULL DEFAULT 5` to `hf_wan22_jobs`. Existing jobs are preserved. Test the pure selection and mocked API interactions using `node tests/hf-wan-auto-duration.test.cjs`.

**Production rollback:** use the prior deployment version from the Cloudflare Deployments panel; the added column can remain because older code ignores it.

### 2026-11-04 rollout

- **Deployed Worker version:** `74ef2b73-d42a-419a-bd9f-ab18c76d4632` at 100% traffic.
- **Deployment ID:** `cb42338a-8ae2-4110-89c7-cd8c8f3a4432`.
- **Immediate rollback version:** `5bf05e79-6458-4585-ab09-c4824e823687`.
- Verified Cloudflare active version, 23 unchanged bindings, D1 duration column, original webhook, quota command, Gradio duration forwarding, and 401 on unauthenticated Telegram requests.
- Not yet tested with a real Telegram-driving video and the user's HF2 account token; actual ZeroGPU account quota, performance and finished render cannot be asserted from these checks.
