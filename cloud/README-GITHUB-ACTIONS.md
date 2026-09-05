# Luxury Hunter on GitHub Actions

This mode runs the worker every 3 hours without depending on your Mac.

Important limitations:
- GitHub-hosted runners are ephemeral. SQLite is restored from the previous workflow artifact and uploaded again at the end.
- The local web UI is not hosted by GitHub Actions. Use it to edit tasks, then export `cloud/config.json` and push that file.
- Xianyu is optional and requires `cloud/xianyu-state.enc` plus the GitHub secret `XIANYU_STATE_PASSWORD`. Never commit the raw Xianyu state JSON.
- Datacenter IPs can trigger Xianyu risk controls. If Xianyu blocks a GitHub runner, the workflow should continue with other sources; do not attempt to bypass CAPTCHA/risk controls.
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
