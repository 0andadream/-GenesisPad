#ifndef GENESIS_AMM_MATH_H
#define GENESIS_AMM_MATH_H

#include <stdint.h>

#define GENESIS_AMM_BPS_DENOMINATOR 10000ULL
#define GENESIS_AMM_MINIMUM_LIQUIDITY 1000ULL
#define GENESIS_AMM_MAX_FEE_BPS 500U

__extension__ typedef unsigned __int128 genesis_u128_t;

typedef struct {
  uint64_t amount_in_after_fee;
  uint64_t fee_amount;
  uint64_t amount_out;
} genesis_swap_quote_t;

uint64_t genesis_isqrt_u128(genesis_u128_t value);
int genesis_quote_initial_liquidity(
  uint64_t amount_one,
  uint64_t amount_two,
  uint64_t *lp_to_creator,
  uint64_t *lp_locked
);
int genesis_quote_add_liquidity(
  uint64_t max_one,
  uint64_t max_two,
  uint64_t reserve_one,
  uint64_t reserve_two,
  uint64_t lp_supply,
  uint64_t *amount_one,
  uint64_t *amount_two,
  uint64_t *lp_minted
);
int genesis_quote_withdraw(
  uint64_t lp_amount,
  uint64_t reserve_one,
  uint64_t reserve_two,
  uint64_t lp_supply,
  uint64_t *amount_one,
  uint64_t *amount_two
);
int genesis_quote_swap_exact_in(
  uint64_t amount_in,
  uint64_t reserve_in,
  uint64_t reserve_out,
  uint16_t fee_bps,
  genesis_swap_quote_t *quote
);

#endif
