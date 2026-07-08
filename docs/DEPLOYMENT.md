# AppScout — Keys, Hosting & Go-Live Guide

This guide covers, in order:

1. [Getting every environment key](#1-getting-the-environment-keys)
2. [Going live locally](#2-go-live-locally-first) (the fastest path to a real run)
3. [Hosting on Azure](#3-hosting-on-azure) (recommended for the Phase 1 CLI pipeline)
4. [Hosting on Vercel](#4-hosting-on-vercel) (the Phase 2 web-app home — with honest caveats)
5. [Go-live checklist](#5-go-live-checklist)

**Platform fit in one paragraph:** Phase 1 is a long-running CLI batch pipeline writing to a local
SQLite file. That shape fits a container job or VM (Azure) perfectly, and fits serverless platforms
(Vercel) poorly — Vercel functions are short-lived and have no persistent disk. Run Phase 1 locally
or on Azure; bring in Vercel when Phase 2 (the Next.js UI) is approved.

---

## 1. Getting the environment keys

AppScout needs exactly two secrets (see `.env.example`):

| Variable | Used by | Where it comes from |
|---|---|---|
| `ANTHROPIC_API_KEY` | Stages 2–4 (extract, research, synthesize) | Anthropic Console |
| `YOUTUBE_API_KEY` | Stage 1 (ingest — video listing) | Google Cloud Console |

The transcript fetch (`youtube-transcript`) needs **no key** — but see the
[datacenter-IP caveat](#transcript-fetching-caveat) below.

### 1.1 `ANTHROPIC_API_KEY`

1. Go to the Anthropic Console: **https://platform.claude.com/** and sign up / sign in.
2. Add billing: **Settings → Billing** — add a payment method or credits. New accounts often get
   trial credits; a full 100-video channel run costs roughly **$15–25** (research dominates).
3. Create the key: **Settings → API keys → Create key**. Name it `appscout` (per-app keys make
   rotation painless). Copy it immediately — it is shown only once. Format: `sk-ant-api03-...`.
4. Optional but recommended:
   - **Workspace**: create an `appscout` workspace and scope the key to it, so you can set a
     workspace-level **spend limit** (e.g. $50/month) as a hard backstop behind the pipeline's own
     `--confirm` cost gate.
   - Check **rate limits** (Settings → Limits). The pipeline runs research sequentially, so even
     the entry tier is sufficient; higher tiers just make retries rarer.

### 1.2 `YOUTUBE_API_KEY` (YouTube Data API v3)

1. Go to **https://console.cloud.google.com/** and sign in with any Google account.
2. Create a project: top bar → project picker → **New project** → name it `appscout` → Create.
3. Enable the API: **APIs & Services → Library** → search **"YouTube Data API v3"** → **Enable**.
4. Create the key: **APIs & Services → Credentials → + Create credentials → API key**. Copy it
   (format `AIza...`).
5. **Restrict the key** (Credentials → click the key):
   - *API restrictions* → Restrict key → select **YouTube Data API v3** only.
   - *Application restrictions* → for server use pick **IP addresses** and add your server's
     egress IP (or leave None while testing locally; tighten before go-live).
6. **Quota**: the default is 10,000 units/day. AppScout's usage is tiny — `channels.list` and
   `playlistItems.list` cost 1 unit each, so a 100-video ingest is ~5 units. No quota increase
   needed.

No OAuth consent screen is required — AppScout only reads public data with an API key.

### Transcript fetching caveat

`youtube-transcript` scrapes YouTube's public caption endpoint. YouTube aggressively rate-limits
and sometimes blocks **datacenter IPs** (Azure, AWS, Vercel). Two consequences:

- **First validation run should happen locally** (residential IP) to separate "package works" from
  "IP is blocked".
- If cloud runs show every video as `transcript_status='error'` while local runs succeed, the
  server IP is blocked. Options: run only the ingest stage locally and ship `data/appscout.db` to
  the server (every stage is independently runnable and resumable, so this split works), or route
  transcript requests through a residential proxy. Per CLAUDE.md, do **not** fall back to scraping
  YouTube HTML or audio transcription.

---

## 2. Go live locally first

The fastest path to a real end-to-end run, and the baseline for debugging any cloud issue:

```bash
git clone https://github.com/Teczo/AppScout.git && cd AppScout
npm install

cp .env.example .env      # then paste both keys into .env

# Smoke run: 10 newest videos, stage by stage
MAX_VIDEOS=10 npm run pipeline -- --channel https://www.youtube.com/@SomeChannel --stage ingest
MAX_VIDEOS=10 npm run pipeline -- --channel https://www.youtube.com/@SomeChannel --stage extract
npm run pipeline -- --channel https://www.youtube.com/@SomeChannel --stage research   # prints cost, asks y/n
npm run pipeline -- --channel https://www.youtube.com/@SomeChannel --stage synthesize

# Then the real thing (idempotent — already-done work is skipped):
npm run pipeline -- --channel https://www.youtube.com/@SomeChannel --confirm
npm run pipeline -- --status
```

Outputs land in `./output/` (report `.md` + apps `.csv`), the DB in `./data/appscout.db`, logs in
`./logs/`.

---

## 3. Hosting on Azure

**Recommended shape: Azure Container Apps *Job*** — a container that runs to completion on demand
or on a schedule, which is exactly what this pipeline is. (Azure Functions is a poor fit: research
runs exceed consumption-plan time limits. A plain B-series VM with cron also works fine if you
prefer pets to containers — see 3.6.)

Prereqs: [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) (`az login`), and the
`Dockerfile` at the repo root.

### 3.1 One-time resource setup

```bash
LOCATION=eastus
RG=appscout-rg
ACR=appscoutacr$RANDOM          # registry names are global — must be unique
ENV_NAME=appscout-env
STORAGE=appscoutsa$RANDOM       # storage names are global too

az group create --name $RG --location $LOCATION
az acr create --resource-group $RG --name $ACR --sku Basic --admin-enabled true
az containerapp env create --name $ENV_NAME --resource-group $RG --location $LOCATION
```

### 3.2 Persistent storage for SQLite + outputs

The container's filesystem is ephemeral; mount an Azure Files share at `/app/data` (and reuse it
for `/app/output`) so the DB and reports survive between runs:

```bash
az storage account create --name $STORAGE --resource-group $RG --location $LOCATION --sku Standard_LRS
az storage share-rm create --storage-account $STORAGE --resource-group $RG --name appscout-data

STORAGE_KEY=$(az storage account keys list --account-name $STORAGE --resource-group $RG --query '[0].value' -o tsv)

az containerapp env storage set --name $ENV_NAME --resource-group $RG \
  --storage-name appscout-data --azure-file-account-name $STORAGE \
  --azure-file-account-key "$STORAGE_KEY" --azure-file-share-name appscout-data \
  --access-mode ReadWrite
```

> **SQLite-on-Azure-Files caveat:** network file shares and SQLite are fine for a single
> sequential job (our case), but never run two pipeline jobs against the same share concurrently.

### 3.3 Build and push the image

```bash
az acr build --registry $ACR --image appscout:v1 .
```

### 3.4 Create the job (secrets as env vars)

```bash
az containerapp job create \
  --name appscout-job --resource-group $RG --environment $ENV_NAME \
  --trigger-type Manual --replica-timeout 7200 --replica-retry-limit 0 \
  --image $ACR.azurecr.io/appscout:v1 \
  --registry-server $ACR.azurecr.io \
  --secrets anthropic-key='sk-ant-api03-...' youtube-key='AIza...' \
  --env-vars ANTHROPIC_API_KEY=secretref:anthropic-key YOUTUBE_API_KEY=secretref:youtube-key \
             DB_PATH=/app/data/appscout.db MAX_VIDEOS=100 \
  --cpu 1 --memory 2Gi \
  --args '--channel' 'https://www.youtube.com/@SomeChannel' '--confirm'
```

Then attach the storage mount (CLI currently requires a YAML patch for job volumes):

```bash
az containerapp job show --name appscout-job --resource-group $RG -o yaml > job.yaml
# In job.yaml under properties.template add:
#   volumes:
#     - name: data
#       storageName: appscout-data
#       storageType: AzureFile
# and under the container entry:
#   volumeMounts:
#     - volumeName: data
#       mountPath: /app/data
az containerapp job update --name appscout-job --resource-group $RG --yaml job.yaml
```

For proper secret hygiene at scale, put the two keys in **Azure Key Vault** and reference them
(`--secrets anthropic-key=keyvaultref:<secret-uri>,identityref:<identity>`); for a single-user
pipeline, Container Apps secrets are acceptable.

### 3.5 Run it and watch

```bash
az containerapp job start --name appscout-job --resource-group $RG
az containerapp job execution list --name appscout-job --resource-group $RG -o table
az containerapp logs show --name appscout-job --resource-group $RG --type console --follow
```

To research a different channel, update `--args` (`az containerapp job update ... --args ...`) and
start again. For a weekly refresh, recreate with `--trigger-type Schedule --cron-expression "0 6 * * 1"`.
Retrieve outputs from the `appscout-data` file share (Portal → storage account → File shares, or
`az storage file download-batch`).

**Cost:** Container Apps Jobs bill per-second of execution — a couple of hours/week is well under
$1/month; the storage account ~ $0.10/month. The Anthropic API spend dwarfs hosting.

### 3.6 Alternative: plain VM

`az vm create --resource-group $RG --name appscout-vm --image Ubuntu2404 --size Standard_B1s ...`,
SSH in, install Node 22 (`nvm`), clone, `.env`, run via `cron`/`systemd` timer. Simpler mental
model, ~$8/month, and you can keep the DB on local disk. Same YouTube datacenter-IP caveat applies.

### 3.7 Zero-Azure alternative: GitHub Actions cron

A scheduled workflow with the two keys in repo **Actions secrets**, uploading `output/` and
`data/appscout.db` as artifacts (or committing the DB to a data branch), gets you scheduled runs
for free. Fine for low-stakes use; runner IPs are datacenter IPs, so the transcript caveat applies.

---

## 4. Hosting on Vercel

**Straight answer: do not host Phase 1 on Vercel.** Three hard blockers:

1. **No long-running processes** — research on a 50-app channel runs tens of minutes; Vercel
   function limits (even Pro/Fluid) are minutes, not hours.
2. **No persistent filesystem** — `./data/appscout.db` (better-sqlite3) vanishes between
   invocations.
3. **Transcript scraping from Vercel's IPs** is the most likely of all platforms to be blocked.

Vercel is the home for **Phase 2** — the Next.js app now in this repo (`app/` + `src/server/`),
approved and built on the Postgres + Inngest architecture below:

### 4.1 Phase 2 shape on Vercel

| Phase 1 piece | Phase 2 replacement |
|---|---|
| SQLite (`better-sqlite3`) | **Vercel Postgres / Neon** — schema was designed to port 1:1 |
| CLI stage runner | **Inngest** (or Trigger.dev) background jobs — each stage becomes a step function with retries; runs survive past function limits |
| `--status` polling | Next.js route reading job progress from Postgres |
| report/CSV files | stored in **Vercel Blob** or rendered from DB |
| interactive `--confirm` | confirmation modal with the same cost estimate |

### 4.2 Vercel setup steps

0. **Local dev first**: `npm run dev` (Next.js on :3000) + `npx inngest-cli@latest dev` (Inngest
   dev server on :8288, auto-discovers `/api/inngest`) + a `DATABASE_URL` pointing at any
   Postgres (Neon free tier works; schema auto-creates on first query).
1. **Import the repo**: https://vercel.com/new → import `Teczo/AppScout` → framework preset
   Next.js (auto-detected).
2. **Environment variables** (Project → Settings → Environment Variables, or CLI):
   ```bash
   npm i -g vercel && vercel login && vercel link
   vercel env add ANTHROPIC_API_KEY production    # paste sk-ant-...
   vercel env add YOUTUBE_API_KEY production      # paste AIza...
   vercel env add DATABASE_URL production         # from Neon/Vercel Postgres
   vercel env add INNGEST_SIGNING_KEY production  # from Inngest dashboard
   vercel env add INNGEST_EVENT_KEY production
   ```
   Add the same for `preview` if you want working preview deployments.
3. **Database**: Vercel Marketplace → Neon (or Storage → Postgres) → create → it injects
   `DATABASE_URL` automatically. Port the five tables from `src/db.ts`.
4. **Background jobs**: Inngest Vercel integration (Marketplace) — it wires the signing/event keys
   and a `/api/inngest` route. Ingest/extract/research/synthesize each become Inngest functions;
   research fans out per app with the same iteration caps.
5. **Transcripts**: run ingest through a proxy provider, or keep a tiny Azure job for ingest only
   and let Vercel handle everything after the transcript is in Postgres.
6. **Deploy**: `git push` (Vercel auto-deploys `main`) or `vercel --prod`. Add a cron in
   `vercel.json` (`{"crons":[{"path":"/api/cron/refresh","schedule":"0 6 * * 1"}]}`) if you want
   scheduled re-ingests triggering Inngest events.

---

## 5. Go-live checklist

- [ ] `ANTHROPIC_API_KEY` created, billing + workspace spend limit set
- [ ] `YOUTUBE_API_KEY` created, restricted to YouTube Data API v3 (+ IP restriction in prod)
- [ ] Local smoke run with `MAX_VIDEOS=10` passes end-to-end (validates the `youtube-transcript`
      dependency on a residential IP)
- [ ] Extraction spot-check: ≥90% of transcripted videos produced apps; names/claims look sane
- [ ] Research spot-check: statuses set, every non-null field has a source URL, claimed vs
      verified revenue kept distinct
- [ ] Full run cost landed within the printed estimate ±30% (compare token logs vs estimate)
- [ ] Re-run of the same command is a no-op (idempotency confirmed on real data)
- [ ] Azure job (or VM/cron) deployed with secrets as secret refs — never in the image or repo
- [ ] `data/` share backed up (it is the system of record; reports/CSV are regenerable)
- [ ] Keys rotated if they were ever pasted anywhere questionable — and never committed (`.env`
      is gitignored)
