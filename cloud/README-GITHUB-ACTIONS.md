# Luxury Hunter on GitHub Actions

This mode checks for due models through GitHub Actions without depending on your Mac.

Important limitations:
- GitHub-hosted runners are ephemeral. SQLite is restored from the previous workflow artifact and uploaded again at the end.
- The local web UI is not hosted by GitHub Actions. Use it to edit tasks, then export `cloud/config.json` and push that file.
- Xianyu is optional and requires `cloud/xianyu-state.enc` or encrypted files in `cloud/xianyu-accounts/`, plus the GitHub secret `XIANYU_STATE_PASSWORD`. Never commit raw Xianyu state JSON.
- Datacenter IPs can trigger Xianyu risk controls. If Xianyu blocks a GitHub runner, the workflow should continue with other sources; do not attempt to bypass CAPTCHA/risk controls.
- Multiple Xianyu accounts are kept separate in the rolling workflow artifact. A failed login can use the next account; any security verification pauses Xianyu for the run.
- The Japan/Buyee connector is still experimental and can return parser warnings.

## Zero-cost recommendation

For multiple tasks every 3 hours, a **public repository** avoids GitHub-hosted standard-runner minute charges. Keep all secrets in GitHub Secrets and commit only encrypted `cloud/config.enc` and, if used, `cloud/xianyu-state.enc`. The repository code is public, but your task criteria/config and login state remain encrypted.

If you use a private repository, GitHub Free currently includes a finite monthly minute quota, so several long-running crawlers every 3 hours can exceed it.

Local flow after editing tasks in the UI:

```bash
npm run cloud:export
npm run cloud:encrypt-config
```

Commit `cloud/config.enc`, not `cloud/config.json`.

## Just One API budget

Each paid Xianyu result page is one API request. In alternate mode, provider
turns happen for individual model tasks inside a workflow run; one workflow run
can therefore make several paid requests. Automatic chained runs honor each
model's `interval_minutes` setting.

Paid searches are spaced according to `XIANYU_JUSTONE_PAGES` and capped at 20
requests per Madrid day and 650 per Madrid month. `XIANYU_DAILY_SEARCH_LIMIT`
and `XIANYU_MONTHLY_SEARCH_LIMIT` may lower these ceilings, never raise them.
At ¥0.20 per request, the daily ceiling limits a 31-day month to ¥124. After
the daily cap, Just One API turns are skipped while the direct Xianyu account
keeps its own turns. This reduces Xianyu coverage to keep the paid budget.
