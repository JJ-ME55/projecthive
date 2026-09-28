/*
 * $HIVE — single source of truth for every address + chain param the site reads.
 * Both dashboard.html and stake.html load this file first and merge it over their defaults,
 * so there is ONE place to wire the launch (no more drift between pages).
 *
 * The wire-launch script (keeper/scripts/wire-launch.mjs) rewrites the LAUNCH block below from the
 * deployed contracts and redeploys the site. Everything under "known" is fixed and already correct.
 * Addresses are EIP-55 checksummed; the pages re-validate the checksum on load and show a banner if
 * anything is malformed, so a fat-fingered paste can never silently read a garbage contract.
 */
window.HIVE_CFG = {
  // ---- LAUNCH block: filled by wire-launch at go-live (empty = pre-launch, pages stay gated) ----
  hiveToken:    "", // $HIVE ERC-20 on Robinhood Chain (the CA you drop)
  curve:        "", // Pons v2 bonding curve for $HIVE
  hiveStaking:  "", // HiveStaking on Robinhood Chain
  seatVault:    "", // Ethereum Safe that holds + runs the seats (set before the first seat buy)

  // ---- known before launch (already deployed / canonical) ----
  splitter:     "0xCFd95537953236E7885f450F001b00960F496bC2", // HiveSplitter — the creator-fee wallet (live)
  potWallet:    "0x84b31CB3D205EfD2d20F29eA7ccaB1bc34326DdB", // seat-treasury float: ETH pooling toward the next seat
  imdRobinhood: "0x5F7Bb59365ce557C26dbcAa4EE9d39A4b95B7127", // bridged IMD reward token on Robinhood (verify pre-deploy)
  identityMd:   "0x0000eC93127BAA929E58E97dd0095A2BFb38ec1D", // identity.md seat NFT (Ethereum)
  imdEth:       "0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7", // IMD token (Ethereum)
  simdVault:    "0x9efa934d9fad4ae28c998a40195646b965a97247", // Staked IMD ERC-4626 vault (Ethereum)

  // ---- chain params ----
  chainId: 4663,
  chainHex: "0x1237",
  rpc: "https://rpc.mainnet.chain.robinhood.com",
  rhRpcs:  ["https://rpc.mainnet.chain.robinhood.com", "https://rpc.ordofi.network"],
  ethRpcs: ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com", "https://rpc.ankr.com/eth"],
  explorer: "https://robinhoodchain.blockscout.com",
  chainName: "Robinhood Chain"
};
