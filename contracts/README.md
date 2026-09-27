# contracts

Three immutable, no-admin contracts. Solidity 0.8.26, [Foundry](https://book.getfoundry.sh/).

- **`HiveSplitter`** — the $HIVE creator-fee recipient on Pons v2. `harvest()` claims accrued ETH fees from the Pons escrow and splits them by fixed shares (seat treasury / ops / team). Permissionless, no owner.
- **`HiveStaking`** — stake $HIVE, earn $IMD pro-rata, weighted by a loyalty multiplier (1.00x to 2.00x over 90 days). MasterChef-style accounting extended so a holder's weight can change. No owner, no pause, no upgrade.
- **`SeatBuyer`** — turns treasury ETH into identity.md seats by filling OpenSea (Seaport) listings, behind two hard rails: a collection check and a price cap. The keeper is an operator, not an owner; it can only ever buy a capped identity.md seat into the vault.

## Test

```bash
forge install                 # forge-std + openzeppelin-contracts
forge test
```

The offline suite runs without a network. The fork test replays a real historical identity.md sale through `SeatBuyer` against production Seaport 1.6, and runs only when an Ethereum archive RPC is provided:

```bash
ETH_FORK_RPC=https://eth.drpc.org forge test --match-contract SeatBuyerFork -vv
```

## Deploy

See [`script/DeployHive.s.sol`](script/DeployHive.s.sol):

- `HiveSplitter` on Robinhood Chain, before launch (its address is the $HIVE creator-fee recipient on Pons).
- `SeatBuyer` on Ethereum.
- `HiveStaking` on Robinhood Chain, after launch (needs the $HIVE token and bridged-IMD addresses).

Every deployment is signed by you. Nothing in this repo holds keys.
