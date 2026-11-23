# AGENTS.md

tack: a private postplan.dev. A Cloudflare Worker + SQLite-backed Durable Objects serve versioned HTML docs at secret links; a Bun CLI uploads them.

## Layout

- `src/worker.ts`: the whole Worker (API, serving, index/history/diff pages, version chip) plus the `Live` and `Store` Durable Objects.
- `src/blobs.ts`: the `Blobs` Durable Object, one SQLite-backed shard per document UUID.
- `cli/tack.ts`: the whole CLI, zero dependencies. Node built-ins only and erasable TypeScript only, so it runs as-is on Node 22.18+ (type stripping) and Bun, and `bun run build` bundles it to `dist/cli` for Node 20+.
- `skill/tack/SKILL.md`: skill that tells agents how to use the CLI.
- `wrangler.jsonc`: Worker config. Deployed from the Cloudflare dashboard via GitHub, so this file is the source of truth on every push. Its build step bundles the CLI and copies the skill and `cli/install.sh` into `dist/`, served as static assets at `/cli`, `/skill.md` and `/install` (free, no Worker invocation), so installs always match the deployed Worker. The installer saves the CLI as `~/.local/share/tack/tack.mjs` (the `.mjs` makes it ESM on every Node 20+, regardless of package.json scope) and links `~/.local/bin/tack` to it. `tack update` re-downloads the CLI and a downloaded skill through unique temp files, and refuses to touch anything inside a git checkout.

## Commands

```sh
bun install
bun run check     # wrangler types + tsc for worker and cli
printf 'TACK_TOKEN=dev\nDOCS_HOST=127.0.0.1:8787\nLIST_HOST=list.localhost:8787\nPRIVATE_HOST=private.localhost:8787\n' > .dev.vars
bun run dev       # local worker with SQLite-backed Durable Objects on :8787; docs on 127.0.0.1, doc list on list.localhost
TACK_URL=http://127.0.0.1:8787 TACK_TOKEN=dev XDG_CONFIG_HOME=/tmp/tack-cfg ./cli/tack.ts upload x.html
```

There are no automated tests. Verify changes against `bun run dev` with the CLI and curl. For token-mode private docs, mint a local unlock link with `tack open --private` using the dev token. To test Access mode, stand in for Access with a local JWKS at `<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs` and signed RS256 tokens, WebSockets included. Never run `tack setup` without `--token` while testing: it sets the secret on the real Worker.

## Slugs

New docs get a slug of 10 random base36 characters (~51 bits), which is what keeps links private; don't shorten it. Links are printed without a trailing slash: single-page docs (and single-page pinned versions) are served at `/id` directly, multi-file ones redirect to `/id/` so relative links resolve.

## Rules

- Bun for repo tooling: `bun`, `bunx`, `bun.lock`. No npm/npx.
- The CLI must not depend on Bun: no `Bun.*` APIs, no top-level await, no TypeScript-only runtime syntax (`cli/tsconfig.json` enforces `erasableSyntaxOnly`). Check changes with `node cli/tack.ts` and `bun run build && node dist/cli`.
- Keep it minimal. No frameworks, no runtime dependencies, no separately billed Cloudflare products. Use SQLite-backed Durable Objects for metadata and bytes. Do not enable billing.
- No comments unless the code would be misleading without one.
- Conventional commits with short messages (`feat: ...`, `fix: ...`).

## Access model

- Docs (`/<slug>/...`, `/<slug>/_history`) are public to anyone with the link. Privacy comes from the 10-char random slug suffix the CLI generates, plus `x-robots-tag: noindex`, `referrer-policy: no-referrer` and a disallow-all `robots.txt`.
- `/api/*` requires `Authorization: Bearer <TACK_TOKEN>` (a Worker secret). It fails closed when the secret is unset.
- The doc list lives on a separate host (`LIST_HOST`, e.g. `list.tack.squeakyfiddlepro.me`) from the docs (`DOCS_HOST`). Docs run arbitrary same-origin JS, so nothing on the docs host may grant access to anything: no cookies, no ambient auth. `/` on the docs host just redirects to the list host. Never move the list, login, or any cookie-authenticated route back onto the docs host.
- On the list host, `/` requires the host-only `__Host-tack` cookie holding the view key `sha256(TACK_TOKEN + ":view")`; it can list docs but never write. List-host responses send `frame-ancestors 'none'`, `X-Frame-Options: DENY`, COOP and CORP `same-origin`, and never any CORS headers. The list's live socket (`/_live` on the list host) needs the cookie and an `Origin` of the list host itself, since the docs host is same-site and would otherwise get the cookie on a WebSocket handshake. It only ever carries an empty `{}` ping, never slugs or titles; the page then refetches `/` and swaps the table, keeping the filter.
- Private docs (`meta.private`, set by `tack upload --private`, cleared only by `--public`; a plain re-upload keeps the mode) are served only on `PRIVATE_HOST`, distinct from the public and list hosts. With `PRIVATE_AUTH=token`, `tack open --private` mints a short-lived fragment grant signed for `unlock:private`. The login POST only accepts its own origin and trades that grant for a seven-day `__Host-tack-private` session signed for `session:private`. The cookie is host-only, HttpOnly, Secure and read-only; neither it nor the grant can unlock the list or authorize API writes. The list cookie cannot unlock private docs. Without `PRIVATE_AUTH`, private auth instead requires both `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` and a Cloudflare Access self-hosted application. In that mode the Worker verifies the RS256 assertion, issuer, audience and times against the team's JWKS on every private doc request, including WebSockets. The JWKS cache is one hour; unknown keys can cause at most one refresh a minute.
- Without a valid private configuration, uploads that would be private are refused, the private host returns 404, and `/api/info` reports no `privateUrl`. The private host serves no public docs, and the docs host serves no private docs (including `_live`, `_history` and `_diff`). Private docs share their origin with each other and can run arbitrary same-origin scripts, but that origin never shares sessions with the public docs host or list. Private doc responses use COOP/CORP `same-origin` and `frame-ancestors 'self'`; login responses cannot be framed. Cross-origin subresource requests get 403 and private `_live` requires its own `Origin` and authentication at connection. API token holders read private docs through `GET /api/raw/<slug>/...` (what `tack get` uses).
- Unlocking: `tack open` asks `/api/info` for the list URL and prints `<list>/login#<exp>.<hmac(TACK_TOKEN, "unlock:<exp>")>`, valid 10 minutes. The code is in the fragment, so it never reaches the server's URL logs or a Referer; the login page POSTs it, clears it from history, and the Worker sets the cookie. It only unlocks the list. `tack open --private` uses the separate private host and grant scope.
- The chip's "last seen" localStorage keys are `HMAC(TACK_TOKEN, "seen:<slug>")`, never derived from the slug alone: every doc's JS can read every key on the docs origin.
- Compare secrets with `same()` (constant time). Never accept the cookie or view key for writes.
- The CLI only uses the saved token for the saved instance's origin; `--url`/`TACK_URL` pointing elsewhere needs `TACK_TOKEN`. Tokens are never taken as command-line arguments (`tack setup --token` reads stdin or a hidden prompt).

## Invariants

- Uploaded files are served byte-for-byte. No sanitizing or CSP sandboxing; that's the point.
- `Store` (named `catalog`) holds document metadata in SQLite. Each document has a stable UUID `id`, allocated on the first blob PUT. It is not listed or served until it has a committed version. `documents` holds meta JSON, list columns, and an `etag` for compare-and-set. Each version inlines up to eight paths; larger maps live in a content-addressed manifest (`manifest` + `count`) from the first commit. Read maps through `filesOf()`. Files and manifests live in the `Blobs` shard named by `id`, in 2 MiB SQLite chunks. Bytes cross RPC as streams.
- Uploaded file paths must already be canonical (no `./`, `//`, `..` or backslashes); the Worker rejects anything it would have to rewrite.
- Uploads are content-addressed: the CLI POSTs `{ files: { path: sha256 }, size, ... }`; the Worker answers `428 { missing }`, the CLI PUTs those raw with `Content-Length` to `/api/docs/<slug>/blobs/<sha256>`, then POSTs again to commit. `Blobs` stages chunks and publishes the hash only after it verifies the length and SHA-256. The Worker never buffers or hashes uploaded file bytes. Metadata commits check both the slug's storage ID and the expected etag.
- `tack rm` refuses while a PUT is active, marks the document as deleting, then calls `deleteAll()` on its shard. An empty shard only initializes if the catalog still has a writable entry for its UUID, so a late PUT cannot recreate a deleted shard. An interrupted delete stays hidden and retrying `tack rm` resumes it. Removing one version leaves its blobs in place. Rename changes the slug and metadata in one SQL update, without touching the shard.
- URL space: `/api/*` (incl. `/api/raw/<slug>/...`), `/login`, `/robots.txt`, `/<slug>/` latest, `/<slug>/v/<n>/` pinned, `/<slug>/_history`, `/<slug>/_diff`, `/<slug>/_live` (WebSocket). Slugs `api`, `login`, `cli` and `install`, and file paths starting with `v`, `_history`, `_diff` or `_live`, are reserved.
- Version numbers are never reused: `meta.lastN` remembers the highest ever issued, so deleting a version can't make an old pinned URL show new content. Numbers can have gaps; use neighbours from `meta.versions`, never `n ± 1`.
- `BAR_JS` is injected into HTML only for `Sec-Fetch-Dest: document` without `?raw`, so API clients and `tack get` always get the exact bytes. The visible chip only renders once a doc has more than one version. At rest it reads `v3 / 3` (amber number on older versions); hover reveals ‹ ›, the version's age and a `changes` link to `_diff`. On the latest view it remembers the last version seen in `localStorage` under `tack:seen:<hash of slug>` (never the raw slug: docs share the origin, so their JS can read it) and, only when there's a newer one, shows `· updated 2h ago` for that visit. The ETag hashes `BAR_JS` and its data so script changes aren't hidden behind cached 304s. All its URLs are built from `location.origin`, never relative (a doc's `<base>` must not see the slug).
- Live updates are pushed, never polled: one `Live` Durable Object per slug holds hibernatable WebSockets from open tabs (read-only; any client message closes the socket). Every state carries `(gen, rev)`: `meta.gen` is issued by the slug's Durable Object (`begin()`, strictly increasing even across clock skew) when a slug starts a new life (created, or renamed into), and `meta.rev` is bumped on every committed change. States also keep the legacy `latest`/`count` fields for tabs opened before a deploy. The DO stores and broadcasts a state only if its `(gen, rev)` is newer than what it has, and tabs act only on states newer than their page, so delayed or reordered notifications (even from a deleted, recreated doc) can't regress state or loop reloads. States carry the version list (`ns`) so pinned tabs can recompute their neighbours. Sockets are tagged `public` or `private` when they connect (the DO stores the scope with the state): a state is sent and replayed only to sockets of its doc's scope, and the rest get `{"gone":true}` and are closed, so a tab opened while a doc was public never sees it after it goes private. Tabs treat `gone` as a normal disconnect and go through the bounded reconnect: one that raced a mode change reconnects to the new state, one on the wrong host gets 404s and gives up. Tabs reset their reconnect budget only after a connection stays up 30 s, stop after ~1 minute of failures, and retry when they become visible. Every `notify()` also pings the `__list__` Live object, which only broadcasts and stores nothing. Doc and list tabs share one reconnect loop (`SOCKET_JS`, interpolated into `BAR_JS` and `LIST_JS`).
- Workers Free can't incur charges: past a free limit, requests fail. Each `Store` call is one subrequest (1,000 per request on Free), so keep calls per request constant, never one per file. Use `Object.hasOwn` for lookups keyed by paths or extensions.
- The CLI never loads `.env` files (Node doesn't by default; don't add dotenv), so a project's `.env` can't redirect the token. It only sends the token to its configured origin, which must be https (http only for localhost), and never follows a redirect to plain http. Running the CLI with plain `bun` would bring back `.env` autoloading; use `node` or `bun --no-env-file`. Folder uploads never follow symlinks.
- `bun run build` recreates `dist/` from scratch and fails unless it holds exactly `cli`, `install`, `skill.md` and the icons from `public/` (`favicon.ico`, `favicon.svg`, `apple-touch-icon.png`): anything in `dist/` is public and served before the Worker.
- Every response is `cache-control: ... no-transform`; without it Cloudflare's bot detection injects a script into HTML and docs stop being byte-for-byte.
- Workers Builds needs the `BUN_VERSION` build variable (≥ 1.4) to read `bun.lock`.

## Cost model (Workers Free)

Keep hot paths bounded in Worker and Durable Object requests, and never poll.

- Page view: 1 Worker request and a Store Durable Object metadata read; each uncached file or manifest costs one `Blobs` call. Edge cache keys include the storage ID and hash. Files larger than 8 MiB skip the cache so teeing the response can't buffer large downloads. Private docs check a session signature or a JWT against cached Access keys.
- Open tab (doc or list): 2 requests to connect the WebSocket (Worker + Durable Object), then nothing while idle; outgoing messages are free. Each change costs one extra DO call to ping the list; an open list tab refetches `/` once per burst of changes (debounced 300 ms); a hidden list tab only marks itself stale and refetches once when shown.
- Identical re-upload: 1 metadata read. Changed upload: lookup missing hashes in one shard call per commit attempt, and 1 PUT per new file. Existing file blobs are never resent.
- Diff page: only for text types (HTML is compared as extracted text, other text line by line with whitespace kept); a cut-off comparison says so; computed once per pair of file hashes and cached under `DIFF_REV` (bump it whenever the diff output changes, or old results stick forever; never cached on read errors); input is capped (first 100 KB, streamed with a byte limit, 1,000 lines, Myers bails past 200 edits, word diffs only for line pairs under 1,200 characters, sharing a 12,000-character budget checked before splitting). Tag matching in `stripHidden` is case-insensitive on the original string; never lowercase and reuse offsets (`İ` changes length).
