# Deployment status — 30-Jul-2026

State of the AWS stack as verified on 30-Jul-2026, the day before the client
evaluation. Written because the client-facing deliverables (`docs/BUILD_REPORT.md`
and both report PDFs) already cite the AWS URLs as live, and one of them is not
yet reachable.

Verify any of this yourself, at any time, with `./deploy/06-verify-live.sh` —
read-only, creates nothing.

## One thing is blocking

**`api-bk.adlmstudio.com` does not resolve (NXDOMAIN).** The A record was never
created, so:

- Let's Encrypt cannot validate the domain → the API has **no certificate**
- the published frontend is compiled against `https://api-bk.adlmstudio.com`
  → **the UI cannot reach its API**

`03-provision-infra.sh` creates this record automatically when the parent zone is
in the same account's Route 53. It is not — the account holds **no hosted zones
at all** — so the script skipped it and recorded `DNS_AUTOMANAGED=no` in
`.env.deploy`. This is the documented manual step, not a script failure.

### The fix

At whatever DNS host serves `adlmstudio.com`:

| field | value |
|---|---|
| type | `A` |
| name | `api-bk` |
| value | `52.18.44.208` |
| TTL | `60` |

**Nothing needs redeploying afterwards.** Caddy is already retrying ACME
(`retrying_in: 120`, `max_duration: 2592000` — 30 days), so it issues the
certificate on its own within a few minutes of the record going live. TTL 60
also keeps a rollback fast.

Then run `./deploy/06-verify-live.sh` and expect all six sections green.

## Everything else is live and verified

| Component | State | Evidence |
|---|---|---|
| EC2 `i-0949cc6784a39c72c` | running, t3.small, eu-west-1 | Elastic IP `52.18.44.208` |
| API container | `Up (healthy)` | `bk-api-1`, docker healthcheck passing |
| Caddy container | `Up` | `bk-caddy-1`, blocked only on ACME (above) |
| MongoDB Atlas | connected | `/healthz` → `{"ok":true,"db":true}` |
| API routes | all 200 | `/api/triage`, `/api/pipeline/iprs`, `/api/reports/latest`, `/api/review`, `/api/todos` |
| Live data | present | 55 IPR rows, 8 triage rows, 48 todos |
| Frontend | published | S3 `bk-poc-frontend-adlm` → CloudFront `d3kbhx0i6234ut.cloudfront.net` |
| SPA fallback | working | `/`, `/products`, `/review` and an unknown route all 200 |
| Bundle API base | correct | `https://api-bk.adlmstudio.com` inlined in `index-DXH5tPCG.js` |
| CORS allowlist | configured | `https://d3kbhx0i6234ut.cloudfront.net,https://bk-po-c.vercel.app` |
| ECR image | pushed | `bk-ingest-api:latest` |
| Billing alarm | `OK` | `bk-ingest-estimated-charges-over-10usd`, $10, us-east-1 |
| SSM access | online | shell without SSH: `aws ssm start-session --target i-0949cc6784a39c72c` |

CORS is configured but has **never been exercised from a browser origin** — every
previous check used `curl`, which sends no `Origin` header. Section 4 of
`06-verify-live.sh` is the first thing that actually tests it, and it cannot run
until DNS is up.

## Also outstanding

**No `ANTHROPIC_API_KEY` on the instance.** `.env.migration` carries MongoDB and
Cloudinary only. The system degrades honestly — every AI call fails closed and
uploads route to human triage (`HANDOFF_PROMPT.md` §2) — so intake, the
registries, review queues, the price ledger, template emission and the whole UI
work as normal, but **live AI extraction will not run in the demo**.

To add it without putting the key in git or a transcript, set it in the
environment and re-stage:

```bash
export ANTHROPIC_API_KEY=...
./deploy/write-env-migration.sh      # prints names and set/skipped status only
./deploy/05-deploy-via-ssm.sh        # restages config, restarts the API
```

## Notes for whoever runs the demo

- The EC2 container runs continuously — there is no Render-style cold start and
  nothing to warm up beforehand.
- Deploys are an explicit script run, not auto-deploy from `main`.
- Render (`bk-poc-1.onrender.com`) and Vercel (`bk-po-c.vercel.app`) are both
  retired. `bk-po-c.vercel.app` remains in `CORS_ORIGINS` deliberately, so the
  old frontend keeps working as a fallback if one is ever needed.
