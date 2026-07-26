# Genesis

![Genesis Ionic column mark](public/genesis-logo.png)

Genesis is a self-custodial token launchpad and hybrid exchange interface built
for the Thru Alphanet. It combines token issuance, wrapped-THRU liquidity pools,
and AMM trading in a restrained classical interface.

**Live app:** [genesispad.vercel.app](https://genesispad.vercel.app/)

## What Genesis does

- Creates or imports a local Thru wallet from a 32-byte Ed25519 private key
- Claims test THRU from the Alphanet faucet
- Sends and receives native THRU
- Deploys fungible token mints through the Thru token program
- Optionally mints an initial token supply
- Optionally seeds a wrapped-THRU AMM pool at launch
- Provides Buy and Sell controls for markets with live liquidity
- Links accounts to the Thru explorer

Private keys remain in browser memory for the current tab. Genesis does not
upload or persist them.

## Launch economics

The current launch configuration uses:

| Setting | Value |
| --- | ---: |
| Opening price | 1 THRU = 500 launched tokens |
| Creator/LP swap fee | 0.21% |
| Genesis protocol fee | 0.09% |
| Total trading fee | 0.30% |

The 0.21% AMM fee accrues to liquidity providers. At launch, the creator holds
the initial LP position. The 0.09% protocol share routes to the configured
Genesis treasury.

Liquidity is optional. A creator can deploy a mint without creating a trading
pool and add liquidity later.

## Network

Genesis currently targets **Thru Alphanet**:

- RPC: `https://rpc.alphanet.thru.org`
- Token program: `taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKqq`
- Wrapped-THRU program: `taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAcH`
- AMM program: provided by `@thru/programs`

Alphanet THRU and launched tokens are test assets without monetary value.

## Technology

- Static HTML and CSS
- Browser JavaScript bundled with esbuild
- `@thru/sdk`
- `@thru/programs`
- GSAP and Three.js for landing-page motion
- pnpm lockfile for reproducible installs

The project intentionally does not use Next.js.

## Local development

Requirements:

- Node.js 22
- pnpm 10 or newer

Install and build:

```bash
pnpm install --frozen-lockfile
pnpm build
```

The deployable output is generated in `dist/`. Serve that directory with any
static server:

```bash
pnpm dlx serve dist
```

## Project structure

```text
.
├── index.html          # Genesis landing page
├── app.js              # Landing-page motion and statistics
├── app/
│   ├── index.html      # Launchpad application
│   ├── app.js          # Wallet, faucet, mint, pool, and trade flows
│   └── *.css           # Application and wallet styling
├── public/             # Logo, sculpture, favicon, and public data
├── scripts/build.mjs   # Static production build
└── vercel.json         # Vercel build configuration
```

## Current data model

Wallet keys are session-only. The local market registry is stored in browser
`localStorage`, while token mints, balances, transfers, liquidity pools, and
trades are submitted to Thru Alphanet.

For a production mainnet release, the registry should be backed by a shared
indexer so markets and statistics remain consistent across browsers.

## Security

This is Alphanet software. Review and audit all transaction-building,
fee-routing, wallet, and AMM code before using it with assets that have value.
Never share a private key or wallet backup.
