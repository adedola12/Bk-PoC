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

## First-time AWS setup

### 1. API host — EC2

1. Launch **Amazon Linux 2023**, `t3.small` (2GB RAM; `t3.micro` at 1GB is tight
   for pdfjs rasterizing a 104-page PDF and will OOM under vision extraction).
2. Paste `deploy/ec2-user-data.sh` into **User data**.
3. **Security group**: inbound `80` and `443` from `0.0.0.0/0`, `22` from your IP only.
4. Allocate an **Elastic IP** and associate it. Without one the address changes
   on stop/start and TLS breaks.
5. **IAM instance role** with `AmazonEC2ContainerRegistryReadOnly` so the box can
   pull from ECR without stored credentials.
6. **DNS**: create an A record `api.<your-domain>` → the Elastic IP. Caddy cannot
   issue a certificate for a bare IP, so this is required, not optional.

### 2. Push the image

```bash
cp deploy/env.deploy.example deploy/.env.deploy   # fill in AWS_REGION, ECR_REPO, API_DOMAIN
./deploy/01-build-and-push.sh
```

Then set `ECR_IMAGE` in `deploy/.env.deploy` to the value the script prints.

### 3. Start the API

```bash
scp deploy/docker-compose.yml deploy/Caddyfile deploy/.env.deploy \
    deploy/.env.migration ec2-user@<elastic-ip>:/opt/bk/
ssh ec2-user@<elastic-ip> 'cd /opt/bk && ./update.sh'
curl https://api.<your-domain>/healthz     # expect {"ok":true,"db":true}
```

Certificate issuance takes ~30s on first boot. If it fails, check the A record
has propagated and port 80 is genuinely open — the ACME HTTP-01 challenge needs it.

### 4. Frontend — S3 + CloudFront

1. Create a **private** S3 bucket (block all public access — CloudFront reaches it
   via Origin Access Control, not public reads).
2. Create a CloudFront distribution:
   - Origin: the S3 bucket, with **Origin Access Control** (create new, sign requests)
   - Viewer protocol policy: **Redirect HTTP to HTTPS**
   - Default root object: `index.html`
   - **SPA fallback — this is the step people miss.** S3 has no rewrite engine, so
     a refresh on `/products` returns 403. Add two **custom error responses**:

     | HTTP error code | Response page path | HTTP response code |
     |---|---|---|
     | 403 | `/index.html` | **200** |
     | 404 | `/index.html` | **200** |

     This replaces the `vercel.json` rewrite and the `_redirects` file a
     Cloudflare deploy would have used. `client/vercel.json` can stay; it is
     inert outside Vercel.
3. Apply the bucket policy CloudFront shows you after creating the OAC.
4. Put the distribution ID into `deploy/.env.deploy`, then:

```bash
./deploy/02-deploy-frontend.sh
```

### 5. Close the CORS loop

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

## Routine redeploys

```bash
./deploy/01-build-and-push.sh                          # API: build + push
ssh ec2-user@<ip> 'cd /opt/bk && ./update.sh'          # API: pull + restart
./deploy/02-deploy-frontend.sh                         # frontend: build + sync + invalidate
```

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
