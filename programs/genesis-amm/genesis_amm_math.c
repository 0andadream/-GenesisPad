#include "genesis_amm_math.h"

static uint64_t min_u64(uint64_t a, uint64_t b) {
  return a < b ? a : b;
}

/* 64×64 → 128 multiply into (hi, lo). */
static void mul_wide(uint64_t a, uint64_t b, uint64_t *hi, uint64_t *lo) {
  uint64_t a_lo = (uint32_t)a;
  uint64_t a_hi = a >> 32;
  uint64_t b_lo = (uint32_t)b;
  uint64_t b_hi = b >> 32;

  uint64_t p0 = a_lo * b_lo;
  uint64_t p1 = a_lo * b_hi;
  uint64_t p2 = a_hi * b_lo;
  uint64_t p3 = a_hi * b_hi;

  uint64_t mid = (p0 >> 32) + (uint32_t)p1 + (uint32_t)p2;
  *lo = (p0 & 0xffffffffULL) | (mid << 32);
  *hi = p3 + (p1 >> 32) + (p2 >> 32) + (mid >> 32);
}

/* Floor(sqrt(n)) for a 64-bit value. */
static uint64_t isqrt_u64(uint64_t n) {
  if (n < 2ULL) return n;
  uint64_t x0 = n;
  uint64_t x1 = (n >> 1) + 1ULL;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x1 + n / x1) >> 1;
  }
  return x0;
}

/* Floor(sqrt(hi:lo)) for a 128-bit value represented as two u64 limbs. */
static uint64_t isqrt_u128(uint64_t hi, uint64_t lo) {
  if (hi == 0ULL) return isqrt_u64(lo);

  /* Binary search in [2^32, 2^64). Result always fits in u64 when hi != 0
     only up to sqrt(2^128-1) which still fits in u64. */
  uint64_t low = 1ULL << 32;
  uint64_t high = UINT64_MAX;
  uint64_t ans = low;

  while (low <= high) {
    uint64_t mid = low + ((high - low) >> 1);
    uint64_t mid_hi, mid_lo;
    mul_wide(mid, mid, &mid_hi, &mid_lo);
    /* mid*mid <= hi:lo ? */
    int le = (mid_hi < hi) || (mid_hi == hi && mid_lo <= lo);
    if (le) {
      ans = mid;
      if (mid == UINT64_MAX) break;
      low = mid + 1ULL;
    } else {
      if (mid == 0ULL) break;
      high = mid - 1ULL;
    }
  }
  return ans;
}

uint64_t genesis_isqrt_product(uint64_t amount_one, uint64_t amount_two) {
  uint64_t hi, lo;
  mul_wide(amount_one, amount_two, &hi, &lo);
  return isqrt_u128(hi, lo);
}

/* (a * b) / d for 64-bit values with intermediate up to 128 bits. */
static uint64_t mul_div_u64(uint64_t a, uint64_t b, uint64_t d) {
  if (!d) return 0;
  uint64_t hi, lo;
  mul_wide(a, b, &hi, &lo);
  /* 128-bit / 64-bit → 64-bit (assumes result fits). */
  /* Shift-subtract division of hi:lo by d. */
  uint64_t q = 0;
  uint64_t r = hi;
  for (int i = 0; i < 64; i++) {
    uint64_t msb = r >> 63;
    r = (r << 1) | (lo >> 63);
    lo <<= 1;
    q <<= 1;
    if (msb || r >= d) {
      r -= d;
      q |= 1ULL;
    }
  }
  return q;
}

/* ceil((a * b) / d) */
static uint64_t mul_div_ceil_u64(uint64_t a, uint64_t b, uint64_t d) {
  if (!d) return 0;
  uint64_t hi, lo;
  mul_wide(a, b, &hi, &lo);
  /* q = floor((hi:lo)/d), r = remainder; return q + (r!=0). */
  uint64_t q = 0;
  uint64_t r = hi;
  for (int i = 0; i < 64; i++) {
    uint64_t msb = r >> 63;
    r = (r << 1) | (lo >> 63);
    lo <<= 1;
    q <<= 1;
    if (msb || r >= d) {
      r -= d;
      q |= 1ULL;
    }
  }
  return r ? q + 1ULL : q;
}

int genesis_quote_initial_liquidity(
  uint64_t amount_one,
  uint64_t amount_two,
  uint64_t *lp_to_creator,
  uint64_t *lp_locked
) {
  if (!amount_one || !amount_two || !lp_to_creator || !lp_locked) return 0;
  uint64_t root = genesis_isqrt_product(amount_one, amount_two);
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

  uint64_t by_one = mul_div_u64(max_one, lp_supply, reserve_one);
  uint64_t by_two = mul_div_u64(max_two, lp_supply, reserve_two);
  uint64_t minted = min_u64(by_one, by_two);
  if (!minted) return 0;

  uint64_t one = mul_div_ceil_u64(minted, reserve_one, lp_supply);
  uint64_t two = mul_div_ceil_u64(minted, reserve_two, lp_supply);
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
  *amount_one = mul_div_u64(lp_amount, reserve_one, lp_supply);
  *amount_two = mul_div_u64(lp_amount, reserve_two, lp_supply);
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

  uint64_t after_fee = mul_div_u64(
    amount_in,
    GENESIS_AMM_BPS_DENOMINATOR - (uint64_t)fee_bps,
    GENESIS_AMM_BPS_DENOMINATOR
  );
  if (!after_fee) return 0;

  /* out = reserve_out * after_fee / (reserve_in + after_fee) */
  uint64_t denom = reserve_in + after_fee;
  if (denom < reserve_in) return 0; /* overflow */
  uint64_t out = mul_div_u64(reserve_out, after_fee, denom);
  if (!out || out >= reserve_out) return 0;

  quote->amount_in_after_fee = after_fee;
  quote->fee_amount = amount_in - after_fee;
  quote->amount_out = out;
  return 1;
}
