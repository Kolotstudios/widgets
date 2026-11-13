# What is live on the `kolot-recorder` worker

Updated by whoever deploys. Compare the dashboard copy with these fingerprints before writing over it.

| Deployed (UTC) | Source | sha256 (first 16; file as in git / without the trailing newline) |
|---|---|---|
| 2026-11-13 17:03 | branch `deploy-live`, commit `7057c19` | `8b211e1ace947cd7` / `af4a059e7aedb98e` |

`7057c19` is the previous live build (`ae10f64`) plus the karaoke-studio additions only: `ks_up_url` (song from a
Drive / Dropbox / MEGA / direct link), `ks_log` and `ks_s_logs` (problems and take diagnostics from users' devices).

Not live: `13e0915` on `main` (B-Sound jingle lyrics template as version 1, `bs_ver` = `mix3`). It was committed by
another session and has not been approved for deployment here; `main` therefore differs from the live build by that commit only.
