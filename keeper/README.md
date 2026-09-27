# hive-keeper

The off-chain orchestrator for the $HIVE flywheel. It turns $HIVE trading fees into identity.md
seats and seat earnings into staker rewards, across two chains, with no custody of the treasury's
long-term assets.

```
 Robinhood Chain                          Ethereum
 ───────────────                          ────────
 $HIVE trades
   │ 5% creator tax
   ▼
 Pons fee escrow ──claim()──► HiveSplitter.harvest()   [lane 1, on-chain, permissionless]
                                   │ split seat/ops/team
                                   ▼
                              seat-treasury float (keeper hot wallet)
                                   │ Relay bridge ETH → ETH            [lane 2]
                                   ▼
                                                        SeatBuyer.buySeat()  [lane 3]
                                                          │ cheapest OpenSea listing,
                                                          │ collection-checked + price-capped
                                                          ▼
                                                        Safe vault owns the seat ──► earns IMD
                                                          │ (Safe moves IMD to keeper)
                                   Relay bridge IMD → IMD ◄┘             [lane 4]
                                   ▼
 HiveStaking.depositReward() ──► stakers                                [lane 5]
```

## The five lanes

Each tick runs the lanes in order; a failure in one is logged to the ledger and never stalls the rest.

1. **harvest** — `HiveSplitter.harvest()` on Robinhood: claims the ETH fees from the Pons escrow and
   splits them seat/ops/team **on-chain**. The keeper only pays gas; the money never touches its wallet.
2. **bridge-eth** — once the seat-treasury float clears `MIN_BRIDGE_ETH_WEI`, bridge it Robinhood → Ethereum
   (Relay, same-asset ETH→ETH) straight into the SeatBuyer.
3. **buy-seat** — read the cheapest live identity.md listings off OpenSea, take the cheapest one that is a
   **basic** Seaport order under the cap, and fill it via `SeatBuyer.buySeat()`. The contract enforces the
   collection-check and price-cap; the seat is forwarded to the Safe vault.
4. **bridge-imd** — bridge seat-earned IMD (once the Safe has moved it to the keeper) Ethereum → Robinhood.
5. **reward** — `HiveStaking.depositReward()` hands the IMD to $HIVE stakers pro-rata by loyalty weight.

## Custody model

- The **seat-treasury float** on Robinhood is the keeper's own hot wallet. It only ever holds a cycle's
  worth of ETH, and the immutable, capped `SeatBuyer` guarantees that ETH can *only* become an identity.md
  seat in the vault — never move anywhere else.
- The **seats and any reserve** live in a **2-of-3 Safe** (`SEAT_VAULT`) the keeper cannot touch. The one
  semi-manual hop is the Safe moving seat-earned IMD to the keeper for the bridge-back; everything on either
  side of it is automated. This keeps seat custody in the multisig while still automating the flywheel.

## Run

```bash
npm install
cp .env.example .env      # fill in at launch (see that file)
npm run config            # print the effective config + which addresses are still unset
npm run test              # typecheck + offline tests (struct parity, mapping, validation)
npm run keeper            # start the loop
```

Useful one-shots: `npm run harvest` (harvest once), `npm run quote` (check Relay chain support + a live
quote), `npm run listings` (cheapest identity.md listings; needs the OpenSea key).

## What's proven vs. launch-gated

- **Proven offline (no key, no launch):** the `BasicOrderParameters` tuple is byte-identical to Seaport's
  canonical `fulfillBasicOrder` (selector `0xfb0f3ee1`), so a mapped OpenSea order fills correctly on-chain;
  the OpenSea→struct mapping (camel + snake case), the cost/cap validation, and the calldata encoding.
- **Proven live:** Relay lists **both** Ethereum (1) and Robinhood Chain (4663) — the same-asset ETH bridge
  route exists.
- **Needs launch to wire/test end-to-end:** the deployed contract addresses, the OpenSea + Relay API keys,
  a funded keeper wallet, and one real fill on a mainnet fork. Set the addresses/keys in `.env`; the code
  is complete behind them.

## Keys needed at launch

- **OpenSea API key** + the identity.md collection slug (listings + fulfillment data).
- **Relay API key** (`/quote` is key-gated on some routes; `/chains` is public).
