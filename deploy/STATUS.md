# Deployment status — 30-Jul-2026 (updated)

State of the AWS stack as verified on 30-Jul-2026, the day before the client
evaluation.

**The DNS record that was blocking this deployment now exists, and the whole
stack verifies green.** `./deploy/06-verify-live.sh` passes all six sections.

Verify any of this yourself, at any time, with `./deploy/06-verify-live.sh` —
read-only, creates nothing.

## Resolved: `api-bk.adlmstudio.com` is live and certificated

The earlier revision of this file recorded one blocker: the A record for
`api-bk.adlmstudio.com` had never been created, because the account held **no
hosted zones at all**, so `03-provision-infra.sh` skipped the step and recorded
`DNS_AUTOMANAGED=no`.

`adlmstudio.com` is now a hosted zone in this account
(`Z04827682WMLSQWM9XP92`), and the registrar's nameservers match the zone's NS
set, so the delegation is live. The A record was created with the same UPSERT
`03-provision-infra.sh` performs:

| field | value |
|---|---|
| type | `A` |
| name | `api-bk.adlmstudio.com` |
| value | `52.18.44.208` |
| TTL | `60` |

Caddy was restarted to skip its accumulated ACME backoff (it had reached
`retrying_in: 1200`, attempt 9, and had fallen back to Let's Encrypt *staging*
after repeated failures). On restart it validated `http-01` against **Let's
Encrypt production** on the first attempt:

```
tls.obtain  certificate obtained successfully
            identifier: api-bk.adlmstudio.com
            issuer:     acme-v02.api.letsencrypt.org-directory
```

Certificate: issuer `C=US, O=Let's Encrypt, CN=YE1`, `notAfter Oct 28 16:36:50
2026 GMT`. Renewal is automatic.

## Everything is live and verified

All six sections of `06-verify-live.sh` pass.

| Component | State | Evidence |
|---|---|---|
| DNS | resolves | `api-bk.adlmstudio.com` → `52.18.44.208` |
| TLS | valid and trusted | Let's Encrypt production, expires 28-Oct-2026 |
| EC2 `i-0949cc6784a39c72c` | running, t3.small, eu-west-1 | Elastic IP `52.18.44.208` |
| API container | `Up (healthy)` | `bk-api-1`, docker healthcheck passing |
| Caddy container | `Up`, certificate issued | `bk-caddy-1` |
| MongoDB Atlas | connected | `/healthz` → `{"ok":true,"db":true}` |
| API routes | all 200 | `/api/triage`, `/api/pipeline/iprs`, `/api/reports/latest`, `/api/review`, `/api/todos` |
| **CORS (browser path)** | **verified both ways** | preflight from CloudFront origin allowed; unknown origin refused (403) |
| Frontend | published | S3 `bk-poc-frontend-adlm` → CloudFront `d3kbhx0i6234ut.cloudfront.net` (`E22ZN5Q70Y20EF`) |
| SPA fallback | working | `/`, `/products`, `/review` and an unknown route all 200 |
| Bundle API base | correct | `index-DXH5tPCG.js` calls `api-bk.adlmstudio.com` |
| ECR image | pushed | `bk-ingest-api:latest` |
| Billing alarm | `OK` | `bk-ingest-estimated-charges-over-10usd`, $10, us-east-1 |
| SSM access | online | `aws ssm start-session --target i-0949cc6784a39c72c` |

CORS had never been exercised from a browser origin before — every earlier check
used `curl`, which sends no `Origin` header. Section 4 now tests it for real, and
it passes in both directions.

## Still outstanding

**No `ANTHROPIC_API_KEY` on the instance.** Confirmed absent inside `bk-api-1`;
`.env.migration` carries MongoDB and Cloudinary only. The system degrades
honestly — every AI call fails closed and uploads route to human triage
(`HANDOFF_PROMPT.md` §2) — so intake, the registries, review queues, the price
ledger, template emission and the whole UI work as normal, but **live AI
extraction will not run in the demo**.

This cannot be staged from a machine that does not hold the key. To add it
without putting it in git or a transcript:

```bash
export ANTHROPIC_API_KEY=...
./deploy/write-env-migration.sh      # prints names and set/skipped status only
./deploy/05-deploy-via-ssm.sh        # restages config, restarts the API
```

Nothing else needs redeploying.

## Running the deploy scripts from a fresh machine

`deploy/.env.deploy` and `deploy/.env.migration` are gitignored, so a fresh clone
has neither and `00-preflight.sh` will FAIL on both. `.env.deploy` holds no
secrets — its values are in `deploy/env.deploy.example` plus the resource IDs in
the table above. `.env.migration` must be regenerated from real secrets via
`write-env-migration.sh`.

`00-preflight.sh` also requires a running Docker daemon and the AWS CLI. Both are
needed only to **rebuild and push the image**; neither is needed to verify or
operate the already-running stack, which is why `06-verify-live.sh` is the right
tool for a pre-demo check.

## Notes for whoever runs the demo

- Demo from **https://d3kbhx0i6234ut.cloudfront.net** — API at
  **https://api-bk.adlmstudio.com**.
- The EC2 container runs continuously — there is no Render-style cold start and
  nothing to warm up beforehand.
- Deploys are an explicit script run, not auto-deploy from `main`.
- Render (`bk-poc-1.onrender.com`) and Vercel (`bk-po-c.vercel.app`) are both
  retired. **Neither is a usable fallback.** `bk-po-c.vercel.app` still serves
  (HTTP 200), which makes it look like one, but its production bundle
  (`index-B3shi2eG.js`) was built on 29-Jul, before the migration, so it calls
  the Render API — and that account is suspended. Demo from the CloudFront URL
  only. The Vercel origin is left in `CORS_ORIGINS` because removing it buys
  nothing and would need an API restart.
