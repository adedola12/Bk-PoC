# BK-Ingest API — container image for AWS.
#
# Why a container and not a Lambda zip: `pdf-to-img` depends on `canvas@3.x`,
# which dynamically links cairo/pango/libjpeg/giflib/librsvg. Those shared
# libraries are absent from the Lambda managed runtime, and every PDF path in
# this app (Stage 0 triage snapshots, page rasterization, vision panel
# segmentation) goes through them. A container lets us install them explicitly.
#
# Build context is the REPO ROOT, not `server/`. It has to be: routes/emit.js
# resolves the BK template as `<server>/../fixtures/...`, so `fixtures/` sits
# one level above the application code. With a `server/` context it is outside
# the build context entirely, never enters the image, and every emission fails
# at runtime with `File not found: /fixtures/catalogue_template_...xlsx` — while
# every read route and the healthcheck stay green. The application code is
# unchanged: `/app` + `/fixtures` reproduces the repo's own layout.

# ─── builder: compile/fetch native deps against the exact runtime libc ───
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Build-time headers for canvas. node-canvas ships prebuilt binaries for
# linux/x64-glibc, but keeping the toolchain here means a source build still
# succeeds if the prebuild is ever unavailable for this platform.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential python3 pkg-config \
      libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
 && rm -rf /var/lib/apt/lists/*

COPY server/package.json server/package-lock.json ./
# Production deps only. Building inside linux/amd64 is also what pulls the
# correct @img/sharp-linux-x64 optional dependency — never ship a dev machine's
# sharp binary.
RUN npm ci --omit=dev

# ─── runtime: the shared libraries only, no toolchain ───
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Runtime shared libs for canvas, plus fonts. Fonts matter: server/services/pdf.js
# rasterizes with `useSystemFonts: true`, and a fontless image renders PDF text as
# blank boxes — which would silently degrade vision extraction accuracy rather
# than fail loudly.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libpangoft2-1.0-0 \
      libjpeg62-turbo libgif7 librsvg2-2 libpixman-1-0 \
      libfreetype6 libfontconfig1 \
      fonts-liberation fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/* \
 && fc-cache -f

COPY --from=builder /app/node_modules ./node_modules
COPY server ./

# The BK bulk-upload template and the Twyford golden file, read at runtime by
# routes/emit.js (TEMPLATE, and styleExamples() for the house-style prompt).
# /fixtures is exactly what `path.resolve(__dirname, "../../fixtures")` yields
# from /app/routes, so the same code path works in the container and locally.
COPY fixtures /fixtures

# server/services/runs.js resolves RUNS_ROOT to <server>/../runs — i.e. /runs
# with this layout. Create it and hand it to the unprivileged node user.
# Ephemeral, exactly as it was on Render: artifacts live for the container's
# lifetime, which covers the emit -> download round trip.
RUN mkdir -p /runs && chown -R node:node /runs /app /fixtures
USER node

# PORT is read at server/index.js:81. 8080 is the AWS container convention.
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "index.js"]
