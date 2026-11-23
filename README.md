<img src=".github/banner.png" alt="tack: let your agents pin HTML to your own Cloudflare" width="100%">

An agent runs `tack upload plan.html` and replies with a link. Uploading again adds a version under the same link, and open tabs update live.

- **Secret links.** Anyone with a link can read it; nobody can guess one.
- **Private docs.** `--private` docs live on a separate host. Only someone with the Tack token can unlock their browser. No Cloudflare Access subscription or card is needed.
- **Versions.** `/id` is the latest, `/id/v/2` is pinned, plus `/_history` and `/_diff`.
- **Anything goes.** Served byte-for-byte: scripts, assets, multi-page folders.
- **No billing setup.** [Cloudflare Workers Free](https://developers.cloudflare.com/durable-objects/platform/pricing/) stores files and metadata in SQLite-backed Durable Objects. There is no external storage account or keepalive job. The limits are 100 MB per upload request, 1 GB per document across its versions, and 5 GB total across the account. Requests that exceed free quotas fail instead of incurring overage charges.

## Setup

1. In Cloudflare Workers & Pages, import this repo on Workers Free. Set the deploy command to `bunx wrangler deploy` and the build variable `BUN_VERSION=1.4.5`. The deploy creates the Durable Object classes. If you use your own domain, set three distinct hostnames in both `routes` and `vars` in `wrangler.jsonc`.

2. Install the CLI and skill (running from the repo needs Node 22.18+):

```sh
bun install
mkdir -p ~/.local/bin ~/.agents/skills
ln -s "$PWD/cli/tack.ts" ~/.local/bin/tack
ln -s "$PWD/skill/tack" ~/.agents/skills/tack
tack setup   # creates a token and sets it on the Worker
tack open    # unlocks the doc list (list.tack.squeakyfiddlepro.me) in your browser
tack open --private   # unlocks private docs in your browser
```

Existing docs from the single-database and R2 deployments are not migrated. Re-upload any docs you want on this instance. Deleting a version keeps its files for deduplication; deleting the whole document removes its stored files.

Any other machine with Node 20+ installs the CLI and skill from your instance:

```sh
curl -fsSL https://tack.squeakyfiddlepro.me/install | sh
tack setup --token   # paste the token from ~/.config/tack/config.json on the first machine
```

## CLI

```
tack upload <file|dir|-> [--new] [--slug s] [--private|--public] [--note n] [--json]
tack get <slug|url> [--v n]
tack list [--match words] [--json]
tack open [slug]
tack open --private
tack rm <slug> [--v n]
tack mv <slug> <new-slug>
tack setup [--token | --rotate]
tack update
```

## Private docs

Upload with `tack upload plan.html --private`. Run `tack open --private` to unlock the browser, then open the doc link. If your installed CLI doesn't recognize `tack open --private`, run `tack update` after the Worker deploys. The unlock link is valid for 10 minutes and the browser session for seven days. Do not share the unlock link. `tack get` uses your configured API token without a browser.

A plain re-upload keeps the current privacy setting. Use `--public` only if you want all versions of the document to be accessible to anyone with the link. Private docs share an origin with each other and can run scripts, so only upload trusted HTML and scripts there. To disable private docs, remove the private host from `routes` and `vars`.

If you already use Cloudflare Access, omit `PRIVATE_AUTH`, put `PRIVATE_HOST` behind a self-hosted Access application, and set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`. Open private docs directly to sign in through Access. This deployment uses `PRIVATE_AUTH=token` instead.

## Dev

```sh
printf 'TACK_TOKEN=dev\nDOCS_HOST=127.0.0.1:8787\nLIST_HOST=list.localhost:8787\nPRIVATE_HOST=private.localhost:8787\n' > .dev.vars
bun run dev
TACK_URL=http://127.0.0.1:8787 TACK_TOKEN=dev tack upload plan.html
```

Internals and invariants are in [AGENTS.md](AGENTS.md).
