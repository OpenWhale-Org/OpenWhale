/** Ethereum diamond, inline SVG — the mark for every EVM cell and the wallet key family. */
export const ETH_LOGO = `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><circle cx='16' cy='16' r='16' fill='%23627EEA'/><path d='M16 4v8.87l7.5 3.35z' fill='%23fff' fill-opacity='.6'/><path d='M16 4 8.5 16.22 16 12.87z' fill='%23fff'/><path d='M16 21.97V28l7.5-10.38z' fill='%23fff' fill-opacity='.6'/><path d='M16 28v-6.03L8.5 17.62z' fill='%23fff'/><path d='m16 20.57 7.5-4.35L16 12.87z' fill='%23fff' fill-opacity='.2'/><path d='m8.5 16.22 7.5 4.35v-7.7z' fill='%23fff' fill-opacity='.6'/></svg>`

/**
 * A chain-agnostic mark for the web3 plugin itself: three linked blocks on a
 * dark disc. No public chain's brand — the plugin is meant to hold EVM, BTC,
 * Solana and Move wallets alike, so nothing in it should read as one of them.
 */
export const WEB3_LOGO = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="%237c3aed"/><stop offset="1" stop-color="%2306b6d4"/></linearGradient></defs><circle cx="16" cy="16" r="16" fill="%230f1020"/><g fill="none" stroke="url(%23g)" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"><path d="M9 11.5 16 8l7 3.5v7L16 22l-7-3.5z"/><path d="M9 11.5 16 15l7-3.5M16 15v7"/><path d="M6 20.5v4M26 20.5v4M6 24.5h4M22 24.5h4"/></g></svg>`
