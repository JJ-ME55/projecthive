# web

The $HIVE site. Static HTML, no build step.

- **`index.html`** — landing: what $HIVE is, the flywheel, the fee split, the trust model.
- **`dashboard.html`** — live treasury dashboard: the pot filling toward the next seat, the fleet of owned seats and their earnings, and staker stats. The live figures switch on as the protocol deploys and buys its first seat.
- **`stake.html`** — the staking dApp: connect a wallet, stake / unstake / claim, with the loyalty multiplier and your live position.
- **`api/floor.js`** — a serverless function that reads the live identity.md floor from OpenSea.
- **`vercel.json`** — a rewrite for the IMD earnings proxy, plus cache headers.

## Run locally

Any static server:

```bash
npx serve web
# or
python -m http.server -d web 8000
```

The dashboard and stake page read the live contract addresses from a `CFG` block at the top of each file. Until those are set they show a pre-launch state.

## Deploy (Vercel)

A static deployment with one serverless function. Set `OPENSEA_API_KEY` (and optionally `OPENSEA_COLLECTION`) as project environment variables to enable the live seat floor.
