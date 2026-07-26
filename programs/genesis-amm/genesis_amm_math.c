#include "genesis_amm_math.h"

static uint64_t min_u64(uint64_t a, uint64_t b) {
  return a < b ? a : b;
}

uint64_t genesis_isqrt_u128(unsigned __int128 value) {
  unsigned __int128 bit = (unsigned __int128)1 << 126;
  unsigned __int128 result = 0;

  while (bit > value) bit >>= 2;
  while (bit != 0) {
    if (value >= result + bit) {
      value -= result + bit;
      result = (result >> 1) + bit;
    } else {
      result >>= 1;
    }
    bit >>= 2;
  }
  return (uint64_t)result;
}

int genesis_quote_initial_liquidity(
  uint64_t amount_one,
  uint64_t amount_two,
  uint64_t *lp_to_creator,
  uint64_t *lp_locked
) {
  if (!amount_one || !amount_two || !lp_to_creator || !lp_locked) return 0;
  uint64_t root = genesis_isqrt_u128(
    (unsigned __int128)amount_one * (unsigned __int128)amount_two
  );
  if (root <= GENESIS_AMM_MINIMUM_LIQUIDITY) return 0;
  *lp_locked = GENESIS_AMM_MINIMUM_LIQUIDITY;
  *lp_to_creator = root - GENESIS_AMM_MINIMUM_LIQUIDITY;
  return 1;
}

int genesis_quote_add_liquidity(
  uint64_t max_one,
  uint64_t max_two,
  uint64_t reserve_one,
  uint64_t reserve_two,
  uint64_t lp_supply,
  uint64_t *amount_one,
  uint64_t *amount_two,
  uint64_t *lp_minted
) {
  if (!max_one || !max_two || !reserve_one || !reserve_two || !lp_supply ||
      !amount_one || !amount_two || !lp_minted) return 0;

  uint64_t by_one = (uint64_t)(
    (unsigned __int128)max_one * lp_supply / reserve_one
  );
  uint64_t by_two = (uint64_t)(
    (unsigned __int128)max_two * lp_supply / reserve_two
  );
  uint64_t minted = min_u64(by_one, by_two);
  if (!minted) return 0;

  uint64_t one = (uint64_t)(
    ((unsigned __int128)minted * reserve_one + lp_supply - 1) / lp_supply
  );
  uint64_t two = (uint64_t)(
    ((unsigned __int128)minted * reserve_two + lp_supply - 1) / lp_supply
  );
  if (one > max_one || two > max_two) return 0;
  *amount_one = one;
  *amount_two = two;
  *lp_minted = minted;
  return 1;
}

int genesis_quote_withdraw(
  uint64_t lp_amount,
  uint64_t reserve_one,
  uint64_t reserve_two,
  uint64_t lp_supply,
  uint64_t *amount_one,
  uint64_t *amount_two
) {
  if (!lp_amount || !reserve_one || !reserve_two || !lp_supply ||
      lp_amount >= lp_supply || !amount_one || !amount_two) return 0;
  *amount_one = (uint64_t)(
    (unsigned __int128)lp_amount * reserve_one / lp_supply
  );
  *amount_two = (uint64_t)(
    (unsigned __int128)lp_amount * reserve_two / lp_supply
  );
  return *amount_one != 0 && *amount_two != 0;
}

int genesis_quote_swap_exact_in(
  uint64_t amount_in,
  uint64_t reserve_in,
  uint64_t reserve_out,
  uint16_t fee_bps,
  genesis_swap_quote_t *quote
) {
  if (!amount_in || !reserve_in || !reserve_out || !quote ||
      fee_bps == 0 || fee_bps > GENESIS_AMM_MAX_FEE_BPS) return 0;

  uint64_t after_fee = (uint64_t)(
    (unsigned __int128)amount_in *
    (GENESIS_AMM_BPS_DENOMINATOR - fee_bps) /
    GENESIS_AMM_BPS_DENOMINATOR
  );
  if (!after_fee) return 0;
  uint64_t out = (uint64_t)(
    (unsigned __int128)reserve_out * after_fee /
    ((unsigned __int128)reserve_in + after_fee)
  );
  if (!out || out >= reserve_out) return 0;

  quote->amount_in_after_fee = after_fee;
  quote->fee_amount = amount_in - after_fee;
  quote->amount_out = out;
  return 1;
}
