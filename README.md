# Genesis

![Genesis Ionic column mark](public/genesis-logo.png)

Genesis is a self-custodial **bonding-curve token launchpad** on Thru Alphanet.
Anyone can launch a market, buy and sell on the public curve, and wrap or unwrap
THRU — all from a restrained classical interface.

**Live app:** [genesispad.vercel.app](https://genesispad.vercel.app/)

## What Genesis does

- Creates or imports a local Thru wallet from a 32-byte Ed25519 private key
- Claims test THRU from the Alphanet faucet
- Sends and receives native THRU (and held tokens)
- Deploys fungible token mints through the Thru token program
- Launches **public bonding-curve markets** (80% of supply on the curve)
- Buys and sells against the curve with a transparent **1%** trade fee
- Marks graduation when the vault hits its THRU target (trading stays open on the curve)
- **Wraps native THRU → wTHRU** and **unwraps wTHRU → THRU** at 1:1 base units
- Lists markets on a shared public registry so every visitor sees the same board
- Links accounts to the Thru explorer

Private keys remain in browser memory for the current tab (with optional session
restore in the same tab). Genesis does not upload private keys to a server.

## Launch economics

| Setting | Value |
| --- | ---: |
| Supply on curve | 80% of minted supply |
| Curve trade fee | 1% |
| Graduation target (Alphanet) | 0.002 THRU raised into the vault |
| Quote asset for curve trades | Native THRU |

Graduation is accounting progress on the curve. Buy and sell remain available on
the public bonding curve after graduation. AMM pool seeding is not the primary
path in the current product.

## Wrap & unwrap

| Action | Result |
| --- | --- |
| **Wrap** | Lock native THRU → mint wTHRU 1:1 |
| **Unwrap** | Burn wTHRU → receive native THRU 1:1 |

Use **wrap** when a program expects wTHRU. Use **unwrap** (or keep native THRU)
for faucet claims, network fees, and bonding-curve buys. Leave a little native
THRU for fees when wrapping.

## Network

Genesis currently targets **Thru Alphanet**:

- RPC: `https://rpc.alphanet.thru.org`
- Token program: `taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKqq`
- Wrapped-THRU program: `taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAcH`
- Explorer: [scan.thru.org](https://scan.thru.org)

Alphanet THRU and launched tokens are test assets without monetary value.

## Technology

- Static HTML and CSS
- Browser JavaScript bundled with esbuild
- `@thru/sdk` / `@thru/programs` / `@thru/wallet`
- Shared public market board via `/api/markets` (+ optional durable mirrors)
- pnpm lockfile for reproducible installs

The project intentionally does not use Next.js for the live launchpad.

## Local development

Requirements:

- Node.js 20+
- pnpm 9+

Install and build:

```bash
pnpm install
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
├── index.html            # Marketing homepage
├── app.js                # Homepage stats, theme, protocol lanes
├── app/
│   ├── index.html        # Launchpad app (Explore, Wrap, Activity)
│   ├── app.js            # Wallet, curve, wrap, registry, trades
│   └── *.css             # App + wallet styling
├── api/
│   └── markets.js        # Public market registry (server merge)
├── public/               # Logo, favicon, bootstrap board, stats
├── scripts/
│   ├── build.mjs         # Static production build
│   └── cleanup-test-markets.mjs
└── vercel.json           # Vercel build + API
```

## Data model

| Data | Where it lives |
| --- | --- |
| Wallet keys | Browser session / tab memory |
| Local market cache | `localStorage` (`genesis-markets-v3`) |
| Public market board | `/api/markets` (+ durable mirrors / gist) |
| Mints, balances, curve fills, wrap/unwrap | Thru Alphanet |

On-chain history is permanent. The public board only indexes markets for the UI.

## Security

This is Alphanet software. Review wallet handling, fee routing, and curve trade
paths before using mainnet assets. Never share a private key or wallet backup.
