# BK-Ingest — AWS deployment runbook

Migration off Render. Frontend to **S3 + CloudFront**, API to **EC2 + Docker**,
database **untouched on MongoDB Atlas**.

```
Browser ──HTTPS──> CloudFront ──> S3 (static React build)
   │
   └───HTTPS──> api.<your-domain>  ──> EC2: Caddy (TLS) ──> API container ──> Atlas
```

## Why this shape

The API is not a normal short-request web service, and that constrains the design:

| Constraint (measured, not assumed) | Consequence |
|---|---|
| Catalogue extraction: **2 min typical, ~12 min worst case** (`docs/BUILD_REPORT.md:94,99`) | Rules out Lambda (15 min cap, and its Function URL), App Runner (**hard 120s** request timeout), and CloudFront-in-front-of-API (30s origin timeout, 60s max) |
| Uploads up to **50MB**; `HD_BOOKET.pdf` fixture is **17MB** | Rules out Lambda Function URLs (6MB payload cap) |
| `pdf-to-img` → `canvas` needs cairo/pango/librsvg | Rules out the Lambda managed runtime; needs a container |
| Cross-request state on local disk (`uploads.js:26` writes, `pipeline.js:48` reads back) | Needs a persistent, single-tenant filesystem |

A long-lived container on EC2 satisfies all four **with zero application code
changes**. That is the point: the only files added are `server/Dockerfile`,
`server/.dockerignore` and this `deploy/` directory.

## Verified before writing this

Built and exercised locally against a real MongoDB:

- image builds (934MB, ~80s); `canvas` rasterizes a real fixture PDF; `sharp`
  loads libvips 8.18.3; pdfjs extracts text
- API boots in **3s**, `/healthz` returns `{"ok":true,"db":true}`
- **17MB upload accepted in 2.3s** end to end
- preview endpoint serves the rendered PNG (200, `image/png`)
- CORS allows a configured origin and 403s an unknown one

---

## Phase 2 — Capture from Render before you touch anything

Do this first. Render is suspended, not deleted; you can still read the dashboard.

- [ ] **Environment variables** — for `bk-ingest-api`, copy every value from
      Dashboard → Service → Environment. Expected set (from `render.yaml` and a
      code audit): `MONGODB_URI`, `ANTHROPIC_API_KEY`, `CLOUDINARY_CLOUD_NAME`,
      `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `CORS_ORIGINS`, `NODE_ENV`.
      **Also check for `CLOUDINARY_FOLDER`** — the code reads it
      (`server/services/cloudinary.js:26`) but it is absent from `render.yaml`
      and `.env.example`, so it may have been set only in the dashboard.
- [ ] Paste them into `deploy/.env.migration` locally. **Confirm it is ignored**:
      `git check-ignore -v deploy/.env.migration` must print a match. It already
      does — `.env.migration` was added to `.gitignore`.
- [ ] **Persistent disk** — the free plan has none, and `runs/` was ephemeral, so
      there is most likely nothing to download. Confirm in the dashboard anyway.
- [ ] **Service configuration** — record build command, start command, health
      check path, region. Current values from `render.yaml`: `npm install`,
      `npm start`, `/healthz`, root dir `server`.
- [ ] **List every other service on the account** so you know the full exposure.
      Nothing else from this repo deploys there, but the account may host
      unrelated ADLM services.

Nothing below runs until this checklist is complete.

---

## Going live

The whole deployment is scripted. Four things must be true first — three you
provide, one AWS cannot infer for you.

```bash
# 1. deployment config
cp deploy/env.deploy.example deploy/.env.deploy
$EDITOR deploy/.env.deploy          # AWS_REGION, ECR_REPO, API_DOMAIN,
                                    # FRONTEND_BUCKET, SSH_KEY_NAME

# 2. application secrets captured from Render (Phase 2 above)
$EDITOR deploy/.env.migration       # MONGODB_URI, ANTHROPIC_API_KEY, Cloudinary…

# 3. an EC2 key pair, if you do not already have one
aws ec2 create-key-pair --key-name bk-ingest --query KeyMaterial \
  --output text > ~/.ssh/bk-ingest.pem && chmod 600 ~/.ssh/bk-ingest.pem

# 4. check everything before spending money — read-only, creates nothing
./deploy/00-preflight.sh
```

Then provision. This creates ECR, the instance role, security group, EC2 box,
Elastic IP, S3 bucket and CloudFront distribution, and writes every resource ID
back into `deploy/.env.deploy`:

```bash
./deploy/03-provision-infra.sh
```

It finishes by printing the Elastic IP. **Create the DNS A record now** —
`api.<your-domain>` → that IP. This is the one manual step, and it is
unavoidable: Caddy cannot obtain a Let's Encrypt certificate for a bare IP, and
your CloudFront frontend is HTTPS, so a plain-HTTP API would be blocked by the
browser as mixed content.

Once DNS resolves:

```bash
./deploy/go-live.sh        # pre-flight -> provision -> build/push -> deploy -> verify
```

`go-live.sh` refuses to continue if DNS does not yet point at the box, rather
than burning a Let's Encrypt rate-limit attempt and leaving you on a broken
certificate. It is idempotent — re-run it after fixing anything.

Finally, the cost guardrail:

```bash
./deploy/04-billing-alarm.sh you@example.com     # $10 CloudWatch alarm
```

Confirm the SNS subscription email, and check **Billing preferences → Receive
Billing Alerts** is enabled — AWS does not publish the `EstimatedCharges` metric
at all until that box is ticked, so the alarm would sit silently in
`INSUFFICIENT_DATA` forever.

### A note on SPA routing

S3 has no rewrite engine, so a hard refresh on `/products` would return 403.
`03-provision-infra.sh` configures CloudFront custom error responses mapping
both **403 → `/index.html` (200)** and **404 → `/index.html` (200)**, which is
what makes client-side routing survive a refresh. This replaces the
`client/vercel.json` rewrite; that file can stay, it is inert outside Vercel.
`go-live.sh` verifies it by requesting `/products` directly and asserting 200.

### Close the CORS loop

`VITE_API_BASE` is inlined at **build** time, so the frontend must be rebuilt
whenever the API domain changes — a redeploy alone is not enough.

On the EC2 box, set in `.env.migration`:

```
CORS_ORIGINS=https://<distribution>.cloudfront.net,https://<your-frontend-domain>
```

then `cd /opt/bk && docker compose up -d`. The allowlist is comma-separated and
normalises case and trailing slashes (`server/index.js:35-42`), so a pasted URL
with a trailing slash still matches.

---

## Deploying without SSH (sandboxed or CI machines)

`go-live.sh` assumes the operator's machine can SSH to the box and build the
image locally. Neither holds in a sandboxed agent environment: outbound port 22
is closed, and the Docker Hub and ECR Public **layer CDNs are blocked**, so
`docker build` fails fetching its own base image.

`deploy/05-deploy-via-ssm.sh` is the path for those machines. Everything goes
over the AWS API on 443:

```bash
./deploy/03-provision-infra.sh     # as normal
./deploy/write-env-migration.sh    # secrets from the environment
./deploy/05-deploy-via-ssm.sh      # build + deploy on the instance itself
./deploy/02-deploy-frontend.sh     # frontend still publishes fine from anywhere
```

It stages config in **SSM Parameter Store** (secrets as KMS-encrypted
`SecureString`, never as Run Command parameters — those stay readable in the
console and CloudTrail for 30 days), then uses **Run Command** to make the
instance clone the repo, build the image, push it to ECR and start the stack.
Because the image still lands in ECR, the `./update.sh` redeploy path below is
unaffected.

Override the source it builds with `GIT_REPO` / `GIT_REF`; `GIT_REF` defaults
to the branch currently checked out, so **push your branch before running it**.

Consequences of this path, both deliberate:

- **Port 22 is never opened.** Shell access is
  `aws ssm start-session --target <instance-id>`. `03-provision-infra.sh` no
  longer derives an SSH rule from the machine's egress IP — behind a shared or
  proxied network that address belongs to other tenants too.
- The instance role carries a **scoped** ECR push policy (that one repository),
  not the blanket `PowerUser` policy, so a compromised box cannot write to any
  other registry.

## Routine redeploys

```bash
./deploy/01-build-and-push.sh                          # API: build + push
ssh ec2-user@<ip> 'cd /opt/bk && ./update.sh'          # API: pull + restart
./deploy/02-deploy-frontend.sh                         # frontend: build + sync + invalidate
```

…or, with no SSH: `./deploy/05-deploy-via-ssm.sh` (rebuilds and restarts).

## Verification after cutover

```bash
curl https://api.<domain>/healthz          # {"ok":true,"db":true}
curl https://api.<domain>/api/triage       # JSON array
curl https://api.<domain>/api/reports/latest
```

Then in the browser: load the CloudFront URL, **refresh on a nested route**
(proves SPA fallback), upload a fixture, run extraction, download an emission.

- Logs: `ssh ec2-user@<ip> 'cd /opt/bk && docker compose logs -f api'`
- Check no secrets appear in log output. The app logs connection *host* only
  (`server/db.js:13`), not the URI — verify this stays true.

## Rollback

The Render service still exists, suspended. Rollback is DNS:

1. Repoint `api.<domain>` back, or rebuild the frontend with
   `VITE_API_BASE=https://bk-poc-1.onrender.com` and redeploy.
2. Reinstate the Render service (requires settling the account).

Roll back if: `/healthz` fails after 10 minutes of debugging, TLS will not issue,
or extraction fails on a fixture that worked on Render. **Lower DNS TTL to 60s at
least an hour before cutover** so this is fast.

## Cost

| Item | Monthly (list price, no credit) |
|---|---|
| EC2 t3.small + 20GB gp3 | ~$17 |
| Elastic IP (attached) | $0 |
| S3 + CloudFront (PoC traffic) | <$1 |
| ECR (<1GB) | ~$0.10 |
| **Total** | **~$18** |

Inside the $25,000 Activate credit, and payable in naira at list price after it
expires in July 2028 — the credit is not load-bearing.

## Out of scope — deliberately untouched

- **MongoDB Atlas** — no migration, no schema change, no data movement.
- **ADLM Cloud, QUIV, RateGen, NIQS** — none are in this repository. The only
  mention is the word "RateGen" in one design-doc sentence as an analogy.
