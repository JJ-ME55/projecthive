/** Lazily-built chain clients. Read-only clients need no key; the signer clients read the key only when first used. */
import { ChainClient } from "./chains.js";
import { ETHEREUM, ROBINHOOD, signerKey } from "./config.js";

let _rh: ChainClient | undefined, _eth: ChainClient | undefined, _rhS: ChainClient | undefined, _ethS: ChainClient | undefined;

export const robinhood = () => (_rh ??= new ChainClient(ROBINHOOD));
export const ethereum = () => (_eth ??= new ChainClient(ETHEREUM));
export const robinhoodSigner = () => (_rhS ??= new ChainClient(ROBINHOOD, signerKey()));
export const ethereumSigner = () => (_ethS ??= new ChainClient(ETHEREUM, signerKey()));
