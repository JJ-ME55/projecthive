# $HIVE

**Own a share of the AI workforce.**

$HIVE is a protocol that turns its trading fees into [identity.md](https://imd.fun) AI-agent seats, runs them, and pays the $IMD those seats earn to everyone who stakes $HIVE.

An identity.md seat is an ERC-721 work permit for an autonomous AI agent, and it costs thousands of dollars. Most people can't buy one. $HIVE pools trading fees to buy them collectively, puts them to work, and streams the earnings back to stakers.

## The flywheel

1. **Trade** — every buy and sell of $HIVE pays a fee to the protocol.
2. **Buy seats** — fees accumulate and buy identity.md seats on OpenSea, cheapest first and price-capped.
3. **Run them** — each seat is registered as an AI agent and earns $IMD.
4. **Pay stakers** — the $IMD is distributed to $HIVE stakers pro-rata, weighted by a loyalty multiplier.
5. **Compound** — a share of earnings buys the next seat.

The seats live on **Ethereum**. $HIVE trades on **Robinhood Chain** (an Ethereum L2), which is where $IMD natively bridges. A keeper moves value between the two.

## Repo layout

| Directory | What |
|---|---|
| [`contracts/`](contracts) | The Solidity: `HiveSplitter` (fee router), `HiveStaking` (stake $HIVE, earn $IMD), `SeatBuyer` (capped, collection-checked Seaport buyer). No admin keys, no upgradeability. Foundry, fully tested. |
| [`keeper/`](keeper) | The off-chain orchestrator (TypeScript) that runs the flywheel across Robinhood Chain and Ethereum: harvest fees, bridge, buy seats, collect earnings, bridge back, top up staking rewards. |
| [`web/`](web) | The site: landing, treasury dashboard, and the staking dApp. |

## Trustless by design

- **No admin keys.** The splitter, staking, and buyer contracts have fixed parameters and no owner. Deployed once, they cannot be changed, paused, or upgraded.
- **Price-capped buying.** The buyer contract refuses to pay above a hard ceiling for a seat, and can only ever turn treasury ETH into an identity.md seat forwarded to the vault.
- **On-chain and public.** Every seat the protocol owns, and every reward distributed, is visible on-chain.

## Build and test

Each part is self-contained. See its README:

- Contracts: [`contracts/README.md`](contracts/README.md) — `forge test`
- Keeper: [`keeper/README.md`](keeper/README.md) — `npm test`
- Web: [`web/README.md`](web/README.md) — static site

## Links

- Site: https://projecthive.fun
- identity.md: https://imd.fun

## Disclaimer

$HIVE is experimental software. It is not affiliated with identity.md or the IMD team. Nothing here is investment advice or a promise of returns; seat earnings depend entirely on real demand for the swarm's work. Read the code and do your own research.

## License

MIT — see [LICENSE](LICENSE).
