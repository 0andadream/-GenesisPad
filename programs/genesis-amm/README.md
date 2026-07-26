# Genesis AMM

Genesis AMM is the on-chain constant-product liquidity engine used by
GenesisPad on Thru Alphanet. It implements the public Thru AMM ABI:

- `init_pool`
- `add_liquidity`
- `withdraw_liquidity`
- `swap`

The pool retains its swap fee inside its reserves. Genesis launches use a
30-basis-point fee: 21 bps accrues to the creator-owned LP position and 9 bps
is routed by the launch transaction to the Genesis protocol treasury.

## Safety

This is testnet software. It has checked arithmetic, bounded fees, pool and
vault address validation, authority checks, CPI return checks, and a
reentrancy guard, but it has not received an independent security audit.

## Build

Native ThruVM compilation currently requires the Linux RISC-V toolchain. The
`Genesis AMM` GitHub Actions workflow installs the official Thru CLI,
toolchain, and C SDK, runs the host math tests, compiles the program, and
publishes the binary plus ABI as a workflow artifact.

Run the host math suite locally:

```sh
make test
```
