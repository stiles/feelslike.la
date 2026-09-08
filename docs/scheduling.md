# Scheduling the pipeline

`update-forecast.yml` runs on `workflow_dispatch` only — no `schedule` trigger. An
external cron service calls `workflow_dispatch` on it once an hour instead.

## Why not GitHub's own `schedule` trigger

GitHub's [docs](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
say the `schedule` event "can be delayed during periods of high loads," and a dropped run
gets no retry and no notification. On this repo — private, low-traffic — that wasn't a
5–30 minute delay now and then; scheduled runs landed 2.5 to 5.5 hours apart instead of
hourly, with no way to tell a dropped tick from a quiet hour. `workflow_dispatch` skips
that queue entirely, so an external trigger calling it is more reliable than GitHub's own
cron, not just a workaround for a broken file.

The app's freshness messaging (see `state.state` in `web/src/format.ts`) still degrades
gracefully — "aging," then "stale" — if the external trigger itself ever goes quiet.
That's the safety net; it isn't the schedule.

## Setup

1. **A fine-grained personal access token.** GitHub → Settings → Developer settings →
   Fine-grained tokens → Generate new token. Scope it to this repository only, with
   repository permission **Actions: Read and write** and nothing else. No expiration
   shorter than you're willing to come back and renew.
2. **A cron service that can set a custom header and body.** [cron-job.org](https://cron-job.org)'s
   free tier does this. Create a job:
   - URL: `https://api.github.com/repos/stiles/feelslike.la/actions/workflows/update-forecast.yml/dispatches`
   - Method: `POST`
   - Headers:
     - `Authorization: Bearer <the token from step 1>`
     - `Accept: application/vnd.github+json`
     - `X-GitHub-Api-Version: 2022-11-28`
   - Body: `{"ref":"main"}`
   - Schedule: every hour, at a few minutes past the hour (matches the pipeline's own
     preference for not landing exactly on `:00`, when NDFD's cycle hasn't either).
3. **Verify it once by hand** before trusting the schedule:

   ```sh
   curl -X POST \
     -H "Authorization: Bearer <token>" \
     -H "Accept: application/vnd.github+json" \
     -H "X-GitHub-Api-Version: 2022-11-28" \
     https://api.github.com/repos/stiles/feelslike.la/actions/workflows/update-forecast.yml/dispatches \
     -d '{"ref":"main"}'
   ```

   A `204` with no body means it queued; check the Actions tab for a new `workflow_dispatch`
   run. A `401` means the token's repo or permission scope is wrong; a `404` usually means
   the workflow filename or `ref` doesn't match.

## If the external trigger goes quiet

Nothing on GitHub's side will tell you. Keep an eye on the Actions tab's run history
occasionally, or add a dead-man's-switch monitor (a service like
[healthchecks.io](https://healthchecks.io)) that expects a ping every hour and alerts when
one doesn't arrive — the same pattern as the cron trigger itself, one level up.
