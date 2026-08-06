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
| Billing alarm | `OK` | `bk-ingest-estimated-charges-over-100usd`, $100, us-east-1 |
| AI provider | Bedrock, via instance role | `/healthz` → `eu.anthropic.claude-opus-4-5-20251101-v1:0`, eu-west-1 |
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

## Resolved: AI extraction runs, on Bedrock

Claude now runs on **Amazon Bedrock**, signed with the EC2 instance role — there
is no API key on the box, none in Parameter Store, and none that can leak
through a transcript. Verified end to end: a real upload classifies
`product_datasheet` at 0.97 via `method: text` (the AI tier), where it
previously fell back to `rule` at 0.

An earlier revision of this file said no `ANTHROPIC_API_KEY` was on the
instance. **That was a bad measurement** — the probe let the host shell expand
`$ANTHROPIC_API_KEY` before it reached the container, so it reported "absent"
without reading the container at all. `.env.migration` now carries a working
key. It is unused: `AI_PROVIDER=bedrock` is set explicitly in
`docker-compose.yml` rather than inferred from the key's absence, because a
stale key silently outranking the instance role is the failure worth designing
out. To check what a box actually resolved, read `/healthz` — it reports the
provider, model and region.

Two Bedrock facts that cost real time to rediscover:

- **Bare model IDs are rejected.** Current Claude models cannot be invoked
  on-demand as `anthropic.claude-*`; they must be addressed through a
  cross-region **inference profile** — the same ID behind an `eu.` or `global.`
  prefix. The error ("not available for this account") points at billing rather
  than at the real cause.
- **`AnthropicBedrock` no-ops against `@anthropic-ai/sdk` 0.57.** Its URL
  rewrite reads a request field that version never passes, so the call goes to
  `/v1/messages` on `bedrock-runtime` and returns `UnknownOperationException`
  with nothing indicating a version skew. Fixed by the bump to 0.115.

The newer `AnthropicBedrockMantle` client is **not** used — its endpoint 404s
for this account.

## Still outstanding

**Three newer models are subscribed but none are callable.** Marketplace
agreements were accepted via the API (`bedrock create-foundation-model-agreement`),
all usage-based with no upfront cost and no refunds:

| Model | Offer | Global standard $/MTok |
|---|---|---|
| `anthropic.claude-opus-5` | `offer-f3u6lgbrem3zs` | $5 in / $25 out |
| `anthropic.claude-sonnet-5` | `offer-2ykemehpsyf7g` | $2 in / $10 out |
| `anthropic.claude-opus-4-8` | `offer-wdkl4yk6s7uu4` | $5 in / $25 out |

All three report `agreementAvailability AVAILABLE`, `authorizationStatus
AUTHORIZED`, `entitlementAvailability AVAILABLE`, `regionAvailability
AVAILABLE` — **identical to the working Sonnet 4.6** — and all three still
return `AccessDeniedException` ("not available for this account") from
`InvokeModel`, on the bare ID and on both the `eu.` and `global.` profiles,
while Sonnet 4.6 succeeds on the same credentials in the same second.

Re-tested at 11:49, 12:49 and 13:27 UTC — unchanged each time, with Sonnet 4.6
passing as a control in the same run. Opus 5 has now held that state for ~110
minutes. That it reproduces identically across three independently accepted
agreements makes propagation lag the weaker explanation and an account-level
gate on newest-generation models the likelier one — consistent with the error's
own hint to "contact AWS Sales". Polling was stopped after the third check;
this needs AWS to answer, not more retries.

**Worth knowing before opening a case:** the Bedrock use-case registration on
this account is filed under **Spendbase** (`https://www.spendbase.co/`, "Software
as a Service"), describing AI-assisted spend-management and procurement
workflows — not ADLM, and not this catalogue-ingestion use case. Read it with
`aws bedrock get-use-case-for-model-access` (the `formData` field is
**double**-base64-encoded). Whether the account is reseller-managed is worth
establishing, since that commonly gates access to newest models regardless of
an accepted agreement.

Nothing further is configurable from here; the remaining action is to re-test:

```bash
aws bedrock-runtime invoke-model --region eu-west-1 \
  --model-id eu.anthropic.claude-opus-5 \
  --body fileb://<(echo '{"anthropic_version":"bedrock-2023-05-31","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}') \
  /dev/stdout
```

When one answers, switching is one variable — set `BEDROCK_MODEL_ID` in
`deploy/docker-compose.yml` and restart the API. The running config is on **Opus 4.5** — the most capable model this account
can actually call — so an entitlement that is accepted but not served cannot
take the demo down.

`claude-opus-4-7` remains unsubscribed. Enabled and callable today: **Opus 4.5
(in use)**, Opus 4.6, Sonnet 4.6, Sonnet 4.5, Haiku 4.5.

Note that `aws bedrock list-foundation-models` lists every model in the region
regardless of entitlement, so it shows Opus 5 as `ACTIVE` and always did. Only
an actual invoke tells you what you can call — and, as this shows, even
`get-foundation-model-availability` can report ready before the runtime agrees.

Nothing else needs redeploying.

**The migrated ledger rows have no files behind them.** Only the Mongo documents
came across from Render; the artifacts sat on Render's ephemeral disk and on a
dev machine, and neither is reachable. 8 of the 9 upload rows therefore name a
file that is not on this deployment.

They no longer fail with a raw `ENOENT` naming a Render path — the extract route
answers `409 source_file_missing` and says to re-upload — but they cannot be
extracted as they stand. **Re-upload any file you intend to demo.** A re-uploaded
file lands in the runs volume and works normally.

The runs volume is ephemeral by design (it was on Render too), so treat uploads
as demo-session state, not as stored records.

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

## Billing alarm

Raised from **$10 to $100** (`bk-ingest-estimated-charges-over-100usd`,
us-east-1) now that inference bills to this account: vision extraction over a
large catalogue passes $10 on normal work, so the old threshold would have fired
on success rather than on anything unexpected. The $10 alarm was deleted — the
threshold is part of the alarm name, so re-running `04-billing-alarm.sh` with a
new value creates a second alarm instead of editing the first.

**The email subscription had been deleted, so the alarm was notifying nobody.**
`dolapo836@gmail.com` has been re-subscribed and is `PendingConfirmation` until
the confirmation email is clicked. This fails silently in both states — the
alarm still reads `OK`, because an alarm with no reachable subscriber looks
exactly like a healthy one. Check it, don't assume it:

```bash
aws sns list-subscriptions-by-topic \
  --topic-arn arn:aws:sns:us-east-1:065634457992:bk-ingest-billing \
  --region us-east-1
```

## Notes for whoever runs the demo

- Demo from **https://bk.adlmstudio.com** — API at
  **https://api-bk.adlmstudio.com**. The raw CloudFront URL
  (`d3kbhx0i6234ut.cloudfront.net`) still works as a fallback for the same
  distribution.
- The EC2 container runs continuously — there is no Render-style cold start and
  nothing to warm up beforehand.
- Deploys are an explicit script run, not auto-deploy from `main`.
- Render (`bk-poc-1.onrender.com`) and Vercel (`bk-po-c.vercel.app`) are both
  retired. **Neither is a usable fallback.**
- `bk-po-c.vercel.app` now **307-redirects to `https://bk.adlmstudio.com`** on
  every path. Until 31-Jul it served its 29-Jul bundle (`index-B3shi2eG.js`),
  built before the migration, so it called the suspended Render API and every
  request died on CORS — while returning HTTP 200, which made it look like a
  working fallback. The redirect removes that trap.
- **Caveat on that redirect:** the Vercel project is still Git-linked to `main`,
  and deploying the redirect changed its build settings. A push to `main` would
  trigger a rebuild that replaces the redirect with a broken page. To make the
  retirement durable, disconnect the project's Git integration or delete the
  project.
- `CORS_ORIGINS` on the box is `https://bk.adlmstudio.com,https://d3kbhx0i6234ut.cloudfront.net`.
  An earlier revision of this file claimed the Vercel origin was in that list; it
  is not, and has not been since the custom-domain work. It would still be
  accepted at runtime, but by the `bk-po-c*.vercel.app` preview-URL regex in
  `server/index.js:40`, not by the allowlist — which is worth knowing before
  concluding from a passing browser call that `CORS_ORIGINS` contains something
  it does not.
