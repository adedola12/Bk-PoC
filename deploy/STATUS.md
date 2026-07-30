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
| **CORS (browser path)** | **verified both ways** | preflight from `https://bk.adlmstudio.com` allowed; unknown origin refused (403) |
| Frontend | published, on a custom domain | `https://bk.adlmstudio.com` → CloudFront `d3kbhx0i6234ut.cloudfront.net` (`E22ZN5Q70Y20EF`) → S3 `bk-poc-frontend-adlm` |
| Frontend TLS | valid and trusted | ACM `CN=bk.adlmstudio.com`, expires 12-Feb-2027, auto-renewing |
| SPA fallback | working | `/`, `/products`, `/review` and an unknown route all 200 |
| Bundle API base | correct | `index-DXH5tPCG.js` calls `api-bk.adlmstudio.com` |
| ECR image | pushed | `bk-ingest-api:latest` |
| Billing alarm | `OK` | `bk-ingest-estimated-charges-over-10usd`, $10, us-east-1 |
| SSM access | online | `aws ssm start-session --target i-0949cc6784a39c72c` |

CORS had never been exercised from a browser origin before — every earlier check
used `curl`, which sends no `Origin` header. Section 4 now tests it for real, and
it passes in both directions.

## The frontend is on `bk.adlmstudio.com`

`deploy/07-frontend-custom-domain.sh` requested an ACM certificate in
**us-east-1** (CloudFront reads certificates from that region only, wherever the
distribution and bucket live), created the DNS validation CNAME, attached the
alias and certificate to `E22ZN5Q70Y20EF`, and pointed the name at the
distribution with a Route 53 **alias A record** — free to query, and the only
record type that would also work at a zone apex.

The certificate had been requested during an earlier attempt and had sat in
`PENDING_VALIDATION` ever since, because the validation CNAME could not be
created while the account had no hosted zone. Creating that record cleared it in
about two minutes.

`d3kbhx0i6234ut.cloudfront.net` still answers — the alias adds a name, it does
not replace one — but **demo from `https://bk.adlmstudio.com`**. The two are the
same distribution and the same bundle.

Note the apex `adlmstudio.com` still has no record of its own and does not
resolve to anything. That is unchanged and unrelated: nothing in this deployment
uses the apex.

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

- Demo from **https://bk.adlmstudio.com** — API at
  **https://api-bk.adlmstudio.com**. The raw CloudFront URL
  (`d3kbhx0i6234ut.cloudfront.net`) still works as a fallback for the same
  distribution.
- The EC2 container runs continuously — there is no Render-style cold start and
  nothing to warm up beforehand.
- Deploys are an explicit script run, not auto-deploy from `main`.
- Render (`bk-poc-1.onrender.com`) and Vercel (`bk-po-c.vercel.app`) are both
  retired. **Neither is a usable fallback.** `bk-po-c.vercel.app` still serves
  (HTTP 200), which makes it look like one, but its production bundle
  (`index-B3shi2eG.js`) was built on 29-Jul, before the migration, so it calls
  the Render API — and that account is suspended. Demo from
  `https://bk.adlmstudio.com` only.
- `CORS_ORIGINS` on the box is `https://bk.adlmstudio.com,https://d3kbhx0i6234ut.cloudfront.net`.
  An earlier revision of this file claimed the Vercel origin was in that list; it
  is not, and has not been since the custom-domain work. It would still be
  accepted at runtime, but by the `bk-po-c*.vercel.app` preview-URL regex in
  `server/index.js:40`, not by the allowlist — which is worth knowing before
  concluding from a passing browser call that `CORS_ORIGINS` contains something
  it does not.
