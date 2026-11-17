<img src=".github/banner.png" alt="tack: let your agents pin HTML to your own Cloudflare" width="100%">

An agent runs `tack upload plan.html` and replies with a link. Uploading again adds a version under the same link, and open tabs update live.

- **Secret links.** Anyone with a link can read it; nobody can guess one.
- **Private docs (off here).** `--private` docs live on a separate host behind Cloudflare Access, so only you can open them. Zero Trust asks for a payment method even on its free plan, so this instance leaves them off.
- **Versions.** `/id` is the latest, `/id/v/2` is pinned, plus `/_history` and `/_diff`.
- **Anything goes.** Served byte-for-byte: scripts, assets, multi-page folders.
- **Workers Free, no card.** Everything lives in SQLite-backed Durable Objects, so there's no R2 (or any other add-on) to subscribe to. The only limits are Cloudflare's: 100 MB per file (the request body limit on a free zone) and 5 GB of storage per account on Workers Free.

## Setup

1. Workers & Pages → Import this repo. Deploy command `bunx wrangler deploy`, build variable `BUN_VERSION=1.4.4`. No bucket or other resource to create first: the first deploy creates the Durable Objects. This instance uses `tack.squeakyfiddlepro.me` for docs and `list.tack.squeakyfiddlepro.me` for the doc list.
2. Install the CLI and skill (running from the repo needs Node 22.18+):

```sh
bun install
mkdir -p ~/.local/bin ~/.agents/skills
ln -s "$PWD/cli/tack.ts" ~/.local/bin/tack
ln -s "$PWD/skill/tack" ~/.agents/skills/tack
tack setup   # creates a token and sets it on the Worker
tack open    # unlocks the doc list (list.tack.squeakyfiddlepro.me) in your browser
```

3. Optional, for private docs (needs a card on file for Zero Trust, even on its free plan): add a `private.` host to `routes` and `PRIVATE_HOST` in `wrangler.jsonc`, then in Zero Trust → Access → Applications add a self-hosted application for it (not "Protect this Worker", which breaks WebSockets) with a policy that allows only your email. Put your team domain (`https://<team>.cloudflareaccess.com`) and the application's AUD tag in `wrangler.jsonc` as `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`. Private docs stay off until all three of `PRIVATE_HOST`, `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are set.

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
tack rm <slug> [--v n]
tack mv <slug> <new-slug>
tack setup [--token | --rotate]
tack update
```

## Dev

```sh
printf 'TACK_TOKEN=dev\nDOCS_HOST=127.0.0.1:8787\nLIST_HOST=list.localhost:8787\n' > .dev.vars
bun run dev
TACK_URL=http://127.0.0.1:8787 TACK_TOKEN=dev tack upload plan.html
```

Internals and invariants are in [AGENTS.md](AGENTS.md).
