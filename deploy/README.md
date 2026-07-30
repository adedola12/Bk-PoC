# Deploy — BK-Ingest API on EC2 via SSM

Config for the API lives in **SSM Parameter Store**, not on the box and not in the repo.
Two scripts cover the config half of a deploy:

| Script | Runs where | Does |
| --- | --- | --- |
| `write-env-migration.sh` | your machine | reads the local `.env`, writes each variable to `$SSM_PREFIX/<NAME>` |
| `05-deploy-via-ssm.sh` | your machine → SSM → instances | renders the parameters to the instance's `EnvironmentFile`, restarts the unit, waits for `/healthz` |

`05-` deploys **config only** — it does not ship application code. Run it after a
parameter change, or as the last step of a code deploy.

## Setup

```bash
cp deploy/deploy.env.example deploy/deploy.env   # gitignored; region, tag, unit, paths
$EDITOR deploy/deploy.env
```

The instance needs: the SSM agent running, an instance profile that can read the
parameters, `jq`, `curl`, and a systemd unit matching `SERVICE_NAME`
(see `bk-ingest-api.service.example`).

## Migrating the env

```bash
./deploy/write-env-migration.sh --dry-run    # see what would be written
./deploy/write-env-migration.sh
```

Output is variable **names plus a status** — `set (created)`, `set (updated)`,
`unchanged`, `skipped (no value in source)`. Values are never printed, and they reach
the AWS CLI through a `0600` temp file rather than argv, so they don't show up in `ps`
either. The script exits non-zero if `ANTHROPIC_API_KEY` or `MONGODB_URI` had no value.

The variable list lives in `ENV_MANIFEST` in `_common.sh` — it mirrors `.env.example`
and every `process.env.*` read in `server/`. Credential-bearing vars go in as
`SecureString`, the rest as `String`. Add new variables there.

Flags: `--env-file PATH` (default `.env` at the repo root), `--from-env` (take values
from the current shell instead of a file), `--prefix`, `--region`, `--dry-run`.

## Deploying

```bash
./deploy/05-deploy-via-ssm.sh --dry-run      # print the remote script, send nothing
./deploy/05-deploy-via-ssm.sh
```

It resolves every Online SSM-managed instance carrying
`tag:$TARGET_TAG_KEY=$TARGET_TAG_VALUE`, fails loudly if there are none, then sends one
`AWS-RunShellScript` command that:

1. reads `$SSM_PREFIX` recursively with decryption — and aborts if the prefix is empty,
   rather than truncating a working env file;
2. renders `NAME='value'` lines (shell-escaped, so values with spaces or `#` survive)
   and installs them atomically at `$REMOTE_ENV_FILE`, `0600 root:root`;
3. `systemctl restart $SERVICE_NAME`, then polls `$HEALTH_URL` for ~30s.

The relayed remote output lists the staged variable names only. On failure it also
includes the last 40 `journalctl` lines for the unit — those are the service's own logs,
so treat that output with the same care as the logs themselves.

Flags: `--dry-run`, `--prefix`, `--region`, `--tag Key=Value`.

## IAM

Your operator credentials need, on `arn:aws:ssm:$AWS_REGION:<account>:parameter$SSM_PREFIX/*`:
`ssm:PutParameter`, `ssm:GetParameter`; plus `ssm:DescribeInstanceInformation`,
`ssm:SendCommand`, `ssm:ListCommandInvocations`, and `kms:Encrypt`/`kms:Decrypt` on the
key backing the `SecureString` values.

The instance profile needs `ssm:GetParametersByPath` on the same prefix, `kms:Decrypt`
on that key, and the usual `AmazonSSMManagedInstanceCore`.

## Rotating a single value

Edit the local `.env`, re-run `write-env-migration.sh` (unchanged parameters are left
alone), then `05-deploy-via-ssm.sh` to restage and restart.
