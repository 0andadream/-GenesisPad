#include "../genesis_amm_math.h"

#include <assert.h>
#include <stdio.h>

int main(void) {
  uint64_t creator = 0, locked = 0;
  assert(genesis_quote_initial_liquidity(
    1000000ULL, 4000000ULL, &creator, &locked
  ));
  assert(creator == 1999000ULL);
  assert(locked == 1000ULL);

  uint64_t one = 0, two = 0, minted = 0;
  assert(genesis_quote_add_liquidity(
    500000ULL, 1000000ULL,
    1000000ULL, 2000000ULL, 1000000ULL,
    &one, &two, &minted
  ));
  assert(one == 500000ULL);
  assert(two == 1000000ULL);
  assert(minted == 500000ULL);

  assert(genesis_quote_withdraw(
    250000ULL, 1500000ULL, 3000000ULL, 1500000ULL, &one, &two
  ));
  assert(one == 250000ULL);
  assert(two == 500000ULL);

  genesis_swap_quote_t quote = {0};
  assert(genesis_quote_swap_exact_in(
    100000ULL, 1000000ULL, 500000000ULL, 30U, &quote
  ));
  assert(quote.amount_in_after_fee == 99700ULL);
  assert(quote.fee_amount == 300ULL);
  assert(quote.amount_out == 45330544ULL);

  assert(!genesis_quote_swap_exact_in(
    100000ULL, 1000000ULL, 500000000ULL, 501U, &quote
  ));

  puts("Genesis AMM math tests passed");
  return 0;
}
