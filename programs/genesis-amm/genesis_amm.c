#include <thru-sdk/c/tn_sdk.h>
#include <thru-sdk/c/tn_sdk_sha256.h>
#include <thru-sdk/c/tn_sdk_syscall.h>

#include "genesis_amm_math.h"

#define ERR_BAD_SIZE 1UL
#define ERR_BAD_INSTRUCTION 2UL
#define ERR_ALREADY_INITIALIZED 3UL
#define ERR_NOT_INITIALIZED 4UL
#define ERR_BAD_INDEX 5UL
#define ERR_BAD_MINT_ORDER 6UL
#define ERR_UNAUTHORIZED 7UL
#define ERR_ACCOUNT_RESIZE 12UL
#define ERR_ACCOUNT_WRITABLE 13UL
#define ERR_TOKEN_CPI 14UL
#define ERR_LIQUIDITY_BOUNDS 17UL
#define ERR_VAULT_MISMATCH 18UL
#define ERR_LP_MINT_MISMATCH 19UL
#define ERR_REENTRANT 20UL
#define ERR_OVERFLOW 21UL
#define ERR_POOL_ACCOUNT_SYSCALL 23UL

#define POOL_DATA_SIZE 203UL
#define TOKEN_ACCOUNT_SIZE 73UL
#define TOKEN_MINT_SIZE 115UL
#define TOKEN_ACCOUNT_AMOUNT_OFFSET 64UL
#define TOKEN_MINT_SUPPLY_OFFSET 1UL
#define MAX_STATE_PROOF_SIZE 6144UL

typedef struct __attribute__((packed)) {
  uchar is_initialized;
  ulong locked_lp_supply;
  ushort swap_fee_bps;
  tn_pubkey_t authority;
  tn_pubkey_t mint_one;
  tn_pubkey_t mint_two;
  tn_pubkey_t vault_one;
  tn_pubkey_t vault_two;
  tn_pubkey_t lp_mint;
} pool_t;

typedef struct __attribute__((packed)) {
  ushort pool;
  ushort user;
  ushort user_one;
  ushort user_two;
  ushort user_lp;
  ushort vault_one;
  ushort vault_two;
  ushort lp_mint;
  ushort token_program;
  ulong amount_one;
  ulong amount_two;
} add_ix_t;

typedef struct __attribute__((packed)) {
  ushort pool;
  ushort user;
  ushort user_one;
  ushort user_two;
  ushort user_lp;
  ushort vault_one;
  ushort vault_two;
  ushort lp_mint;
  ushort token_program;
  ulong lp_amount;
} withdraw_ix_t;

typedef struct __attribute__((packed)) {
  ushort pool;
  ushort authority;
  ushort user_input;
  ushort user_output;
  ushort vault_input;
  ushort vault_output;
  ushort lp_mint;
  ushort token_program;
  ulong amount_in;
} swap_ix_t;

static ushort load_u16(uchar const *p) { return TSDK_LOAD(ushort, p); }
static uint load_u32(uchar const *p) { return TSDK_LOAD(uint, p); }
static ulong load_u64(uchar const *p) { return TSDK_LOAD(ulong, p); }

static void require_idx(ushort idx) {
  TSDK_ASSERT_OR_REVERT(tsdk_is_account_idx_valid(idx), ERR_BAD_INDEX);
}

static tn_pubkey_t const *key_at(ushort idx) {
  require_idx(idx);
  return &tsdk_get_txn()->input_pubkeys[idx];
}

static int key_eq(tn_pubkey_t const *a, tn_pubkey_t const *b) {
  return memcmp(a, b, sizeof(tn_pubkey_t)) == 0;
}

static ulong token_amount(ushort idx) {
  tsdk_account_meta_t const *meta = tsdk_get_account_meta(idx);
  TSDK_ASSERT_OR_REVERT(meta && meta->data_sz == TOKEN_ACCOUNT_SIZE, ERR_VAULT_MISMATCH);
  return load_u64((uchar const *)tsdk_get_account_data_ptr(idx) +
                  TOKEN_ACCOUNT_AMOUNT_OFFSET);
}

static ulong mint_supply(ushort idx) {
  tsdk_account_meta_t const *meta = tsdk_get_account_meta(idx);
  TSDK_ASSERT_OR_REVERT(meta && meta->data_sz == TOKEN_MINT_SIZE, ERR_LP_MINT_MISMATCH);
  return load_u64((uchar const *)tsdk_get_account_data_ptr(idx) +
                  TOKEN_MINT_SUPPLY_OFFSET);
}

static void require_token_owner(ushort account, ushort token_program, ulong err) {
  tsdk_account_meta_t const *meta = tsdk_get_account_meta(account);
  TSDK_ASSERT_OR_REVERT(
    meta && key_eq(&meta->owner, key_at(token_program)), err
  );
}

static void cpi(ushort token_program, uchar const *data, ulong size,
                tsdk_invoke_auth_t const *auth) {
  ulong invoke_error = 0;
  ulong result = tsys_invoke(data, size, token_program, auth, &invoke_error);
  TSDK_ASSERT_OR_REVERT(result == 0 && invoke_error == 0, ERR_TOKEN_CPI);
}

static void token_transfer(ushort token_program, ushort source,
                           ushort destination, ulong amount,
                           tsdk_invoke_auth_t const *auth) {
  uchar ix[13];
  ix[0] = 2U;
  TSDK_STORE(ushort, ix + 1, source);
  TSDK_STORE(ushort, ix + 3, destination);
  TSDK_STORE(ulong, ix + 5, amount);
  cpi(token_program, ix, sizeof(ix), auth);
}

static void token_mint(ushort token_program, ushort mint, ushort destination,
                       ushort authority, ulong amount,
                       tsdk_invoke_auth_t const *auth) {
  uchar ix[15];
  ix[0] = 3U;
  TSDK_STORE(ushort, ix + 1, mint);
  TSDK_STORE(ushort, ix + 3, destination);
  TSDK_STORE(ushort, ix + 5, authority);
  TSDK_STORE(ulong, ix + 7, amount);
  cpi(token_program, ix, sizeof(ix), auth);
}

static void token_burn(ushort token_program, ushort account, ushort mint,
                       ushort authority, ulong amount) {
  uchar ix[15];
  ix[0] = 4U;
  TSDK_STORE(ushort, ix + 1, account);
  TSDK_STORE(ushort, ix + 3, mint);
  TSDK_STORE(ushort, ix + 5, authority);
  TSDK_STORE(ulong, ix + 7, amount);
  cpi(token_program, ix, sizeof(ix), NULL);
}

static pool_t const *load_pool(ushort pool_idx) {
  require_idx(pool_idx);
  TSDK_ASSERT_OR_REVERT(
    tsdk_is_account_owned_by_current_program(pool_idx), ERR_NOT_INITIALIZED
  );
  tsdk_account_meta_t const *meta = tsdk_get_account_meta(pool_idx);
  TSDK_ASSERT_OR_REVERT(meta && meta->data_sz == POOL_DATA_SIZE, ERR_NOT_INITIALIZED);
  pool_t const *pool = (pool_t const *)tsdk_get_account_data_ptr(pool_idx);
  TSDK_ASSERT_OR_REVERT(pool->is_initialized == 1U, ERR_NOT_INITIALIZED);
  TSDK_ASSERT_OR_REVERT(
    key_eq(&pool->authority, key_at(pool_idx)), ERR_UNAUTHORIZED
  );
  return pool;
}

static void validate_common(pool_t const *pool, ushort pool_idx,
                            ushort vault_one, ushort vault_two,
                            ushort lp_mint, ushort token_program) {
  require_token_owner(vault_one, token_program, ERR_VAULT_MISMATCH);
  require_token_owner(vault_two, token_program, ERR_VAULT_MISMATCH);
  require_token_owner(lp_mint, token_program, ERR_LP_MINT_MISMATCH);
  TSDK_ASSERT_OR_REVERT(key_eq(&pool->vault_one, key_at(vault_one)), ERR_VAULT_MISMATCH);
  TSDK_ASSERT_OR_REVERT(key_eq(&pool->vault_two, key_at(vault_two)), ERR_VAULT_MISMATCH);
  TSDK_ASSERT_OR_REVERT(key_eq(&pool->lp_mint, key_at(lp_mint)), ERR_LP_MINT_MISMATCH);
  (void)pool_idx;
}

static void pool_auth(ushort pool_idx, uchar storage[24],
                      tsdk_invoke_auth_t const **out) {
  tsdk_invoke_auth_t *auth = (tsdk_invoke_auth_t *)storage;
  auth->magic = TSDK_INVOKE_AUTH_MAGIC;
  auth->auth_cnt = 1U;
  auth->deauth_cnt = 0U;
  auth->acc_idxs[0] = pool_idx;
  *out = auth;
}

static void handle_add(uchar const *data, ulong size) {
  TSDK_ASSERT_OR_REVERT(size == sizeof(add_ix_t), ERR_BAD_SIZE);
  add_ix_t const *ix = (add_ix_t const *)data;
  require_idx(ix->user);
  TSDK_ASSERT_OR_REVERT(tsdk_is_account_authorized_by_idx(ix->user), ERR_UNAUTHORIZED);
  pool_t const *pool = load_pool(ix->pool);
  validate_common(pool, ix->pool, ix->vault_one, ix->vault_two,
                  ix->lp_mint, ix->token_program);

  uint64_t reserve_one = token_amount(ix->vault_one);
  uint64_t reserve_two = token_amount(ix->vault_two);
  uint64_t supply = mint_supply(ix->lp_mint);
  uint64_t amount_one, amount_two, minted;
  uint64_t locked = pool->locked_lp_supply;

  if (reserve_one == 0 && reserve_two == 0 && supply == 0) {
    TSDK_ASSERT_OR_REVERT(genesis_quote_initial_liquidity(
      ix->amount_one, ix->amount_two, &minted, &locked
    ), ERR_LIQUIDITY_BOUNDS);
    pool_t *writable_pool = (pool_t *)tsdk_get_account_data_ptr(ix->pool);
    TSDK_ASSERT_OR_REVERT(tsys_set_account_data_writable(ix->pool) == 0,
                          ERR_ACCOUNT_WRITABLE);
    writable_pool->locked_lp_supply = locked;
    amount_one = ix->amount_one;
    amount_two = ix->amount_two;
  } else {
    TSDK_ASSERT_OR_REVERT(reserve_one && reserve_two, ERR_LIQUIDITY_BOUNDS);
    TSDK_ASSERT_OR_REVERT(supply <= UINT64_MAX - locked, ERR_OVERFLOW);
    TSDK_ASSERT_OR_REVERT(genesis_quote_add_liquidity(
      ix->amount_one, ix->amount_two, reserve_one, reserve_two,
      supply + locked, &amount_one, &amount_two, &minted
    ), ERR_LIQUIDITY_BOUNDS);
  }

  token_transfer(ix->token_program, ix->user_one, ix->vault_one, amount_one, NULL);
  token_transfer(ix->token_program, ix->user_two, ix->vault_two, amount_two, NULL);
  uchar auth_storage[24];
  tsdk_invoke_auth_t const *auth;
  pool_auth(ix->pool, auth_storage, &auth);
  token_mint(ix->token_program, ix->lp_mint, ix->user_lp, ix->pool, minted, auth);
}

static void handle_withdraw(uchar const *data, ulong size) {
  TSDK_ASSERT_OR_REVERT(size == sizeof(withdraw_ix_t), ERR_BAD_SIZE);
  withdraw_ix_t const *ix = (withdraw_ix_t const *)data;
  TSDK_ASSERT_OR_REVERT(tsdk_is_account_authorized_by_idx(ix->user), ERR_UNAUTHORIZED);
  pool_t const *pool = load_pool(ix->pool);
  validate_common(pool, ix->pool, ix->vault_one, ix->vault_two,
                  ix->lp_mint, ix->token_program);
  uint64_t supply = mint_supply(ix->lp_mint);
  TSDK_ASSERT_OR_REVERT(supply <= UINT64_MAX - pool->locked_lp_supply, ERR_OVERFLOW);
  uint64_t one, two;
  TSDK_ASSERT_OR_REVERT(genesis_quote_withdraw(
    ix->lp_amount, token_amount(ix->vault_one), token_amount(ix->vault_two),
    supply + pool->locked_lp_supply, &one, &two
  ), ERR_LIQUIDITY_BOUNDS);
  token_burn(ix->token_program, ix->user_lp, ix->lp_mint, ix->user, ix->lp_amount);
  uchar auth_storage[24];
  tsdk_invoke_auth_t const *auth;
  pool_auth(ix->pool, auth_storage, &auth);
  token_transfer(ix->token_program, ix->vault_one, ix->user_one, one, auth);
  token_transfer(ix->token_program, ix->vault_two, ix->user_two, two, auth);
}

static void handle_swap(uchar const *data, ulong size) {
  TSDK_ASSERT_OR_REVERT(size == sizeof(swap_ix_t), ERR_BAD_SIZE);
  swap_ix_t const *ix = (swap_ix_t const *)data;
  TSDK_ASSERT_OR_REVERT(
    tsdk_is_account_authorized_by_idx(ix->authority), ERR_UNAUTHORIZED
  );
  pool_t const *pool = load_pool(ix->pool);
  require_token_owner(ix->vault_input, ix->token_program, ERR_VAULT_MISMATCH);
  require_token_owner(ix->vault_output, ix->token_program, ERR_VAULT_MISMATCH);
  int forward = key_eq(&pool->vault_one, key_at(ix->vault_input)) &&
                key_eq(&pool->vault_two, key_at(ix->vault_output));
  int reverse = key_eq(&pool->vault_two, key_at(ix->vault_input)) &&
                key_eq(&pool->vault_one, key_at(ix->vault_output));
  TSDK_ASSERT_OR_REVERT(forward || reverse, ERR_VAULT_MISMATCH);
  TSDK_ASSERT_OR_REVERT(key_eq(&pool->lp_mint, key_at(ix->lp_mint)),
                        ERR_LP_MINT_MISMATCH);

  genesis_swap_quote_t quote;
  TSDK_ASSERT_OR_REVERT(genesis_quote_swap_exact_in(
    ix->amount_in, token_amount(ix->vault_input), token_amount(ix->vault_output),
    pool->swap_fee_bps, &quote
  ), ERR_LIQUIDITY_BOUNDS);

  token_transfer(ix->token_program, ix->user_input, ix->vault_input,
                 ix->amount_in, NULL);
  uchar auth_storage[24];
  tsdk_invoke_auth_t const *auth;
  pool_auth(ix->pool, auth_storage, &auth);
  token_transfer(ix->token_program, ix->vault_output, ix->user_output,
                 quote.amount_out, auth);
}

static void token_initialize_mint(
  ushort token_program, ushort mint, ushort pool, uchar const seed[32],
  uchar const *proof, ulong proof_size
) {
  TSDK_ASSERT_OR_REVERT(proof_size <= MAX_STATE_PROOF_SIZE, ERR_BAD_SIZE);
  uchar ix[1UL + 141UL + MAX_STATE_PROOF_SIZE];
  memset(ix, 0, 1UL + 141UL + proof_size);
  ix[0] = 0U;
  TSDK_STORE(ushort, ix + 1, mint);
  ix[3] = 6U;
  memcpy(ix + 4, key_at(pool), 32);
  memcpy(ix + 36, key_at(pool), 32);
  /* freeze authority remains the zero pubkey; has_freeze_authority is zero */
  ix[101] = 6U;
  memcpy(ix + 102, "GEN-LP", 6);
  memcpy(ix + 110, seed, 32);
  memcpy(ix + 142, proof, proof_size);
  cpi(token_program, ix, 142UL + proof_size, NULL);
}

static void token_initialize_account(
  ushort token_program, ushort account, ushort mint, ushort pool,
  uchar const seed[32], uchar const *proof, ulong proof_size
) {
  TSDK_ASSERT_OR_REVERT(proof_size <= MAX_STATE_PROOF_SIZE, ERR_BAD_SIZE);
  uchar ix[1UL + 38UL + MAX_STATE_PROOF_SIZE];
  ix[0] = 1U;
  TSDK_STORE(ushort, ix + 1, account);
  TSDK_STORE(ushort, ix + 3, mint);
  TSDK_STORE(ushort, ix + 5, pool);
  memcpy(ix + 7, seed, 32);
  memcpy(ix + 39, proof, proof_size);
  cpi(token_program, ix, 39UL + proof_size, NULL);
}

static void handle_init(uchar const *data, ulong size) {
  /* Eight account indices, fee, LP seed, four proof sizes, then proofs. */
  TSDK_ASSERT_OR_REVERT(size >= 82UL, ERR_BAD_SIZE);
  ushort payer = load_u16(data);
  ushort pool_idx = load_u16(data + 2);
  ushort lp_mint = load_u16(data + 4);
  ushort vault_one = load_u16(data + 6);
  ushort vault_two = load_u16(data + 8);
  ushort mint_one = load_u16(data + 10);
  ushort mint_two = load_u16(data + 12);
  ushort token_program = load_u16(data + 14);
  ushort fee_bps = load_u16(data + 16);
  uchar const *pool_seed = data + 18;
  ulong pool_proof_size = load_u64(data + 50);
  ulong lp_proof_size = load_u64(data + 58);
  ulong one_proof_size = load_u64(data + 66);
  ulong two_proof_size = load_u64(data + 74);
  genesis_u128_t total = 82U;
  total += pool_proof_size;
  total += lp_proof_size;
  total += one_proof_size;
  total += two_proof_size;
  TSDK_ASSERT_OR_REVERT(total == size, ERR_BAD_SIZE);

  require_idx(payer);
  require_idx(pool_idx);
  require_idx(lp_mint);
  require_idx(vault_one);
  require_idx(vault_two);
  require_idx(mint_one);
  require_idx(mint_two);
  require_idx(token_program);
  TSDK_ASSERT_OR_REVERT(tsdk_is_account_authorized_by_idx(payer), ERR_UNAUTHORIZED);
  TSDK_ASSERT_OR_REVERT(
    memcmp(key_at(mint_one), key_at(mint_two), 32) < 0, ERR_BAD_MINT_ORDER
  );
  TSDK_ASSERT_OR_REVERT(
    fee_bps > 0 && fee_bps <= GENESIS_AMM_MAX_FEE_BPS, ERR_LIQUIDITY_BOUNDS
  );

  uchar const *pool_proof = data + 82;
  uchar const *lp_proof = pool_proof + pool_proof_size;
  uchar const *one_proof = lp_proof + lp_proof_size;
  uchar const *two_proof = one_proof + one_proof_size;

  if (!tsdk_account_exists(pool_idx)) {
    TSDK_ASSERT_OR_REVERT(
      tsys_account_create(pool_idx, pool_seed, pool_proof, pool_proof_size) == 0,
      ERR_POOL_ACCOUNT_SYSCALL
    );
    return;
  }
  TSDK_ASSERT_OR_REVERT(
    tsdk_is_account_owned_by_current_program(pool_idx), ERR_ALREADY_INITIALIZED
  );
  tsdk_account_meta_t const *pool_meta = tsdk_get_account_meta(pool_idx);
  TSDK_ASSERT_OR_REVERT(
    pool_meta && pool_meta->data_sz == 0, ERR_ALREADY_INITIALIZED
  );
  TSDK_ASSERT_OR_REVERT(
    tsys_set_account_data_writable(pool_idx) == 0, ERR_ACCOUNT_WRITABLE
  );
  TSDK_ASSERT_OR_REVERT(
    tsys_account_resize(pool_idx, POOL_DATA_SIZE) == 0, ERR_ACCOUNT_RESIZE
  );

  uchar lp_seed_input[39];
  uchar lp_seed[32];
  memcpy(lp_seed_input, key_at(pool_idx), 32);
  memcpy(lp_seed_input + 32, "lp_mint", 7);
  tsdk_sha256_hash(lp_seed_input, sizeof(lp_seed_input), lp_seed);
  token_initialize_mint(
    token_program, lp_mint, pool_idx, lp_seed, lp_proof, lp_proof_size
  );
  uchar vault_one_seed[32] = {0};
  uchar vault_two_seed[32] = {0};
  vault_one_seed[0] = 1U;
  vault_two_seed[0] = 2U;
  token_initialize_account(
    token_program, vault_one, mint_one, pool_idx,
    vault_one_seed, one_proof, one_proof_size
  );
  token_initialize_account(
    token_program, vault_two, mint_two, pool_idx,
    vault_two_seed, two_proof, two_proof_size
  );

  pool_t *pool = (pool_t *)tsdk_get_account_data_ptr(pool_idx);
  memset(pool, 0, sizeof(*pool));
  pool->is_initialized = 1U;
  pool->swap_fee_bps = fee_bps;
  memcpy(&pool->authority, key_at(pool_idx), 32);
  memcpy(&pool->mint_one, key_at(mint_one), 32);
  memcpy(&pool->mint_two, key_at(mint_two), 32);
  memcpy(&pool->vault_one, key_at(vault_one), 32);
  memcpy(&pool->vault_two, key_at(vault_two), 32);
  memcpy(&pool->lp_mint, key_at(lp_mint), 32);
}

TSDK_ENTRYPOINT_FN void
start(void const *instruction_data, ulong instruction_data_sz) {
  TSDK_ASSERT_OR_REVERT(!tsdk_is_program_reentrant(), ERR_REENTRANT);
  TSDK_ASSERT_OR_REVERT(instruction_data_sz >= 4UL, ERR_BAD_SIZE);
  uchar const *bytes = (uchar const *)instruction_data;
  uint discriminant = load_u32(bytes);
  uchar const *payload = bytes + 4;
  ulong payload_size = instruction_data_sz - 4UL;

  switch (discriminant) {
    case 0U: handle_init(payload, payload_size); break;
    case 1U: handle_add(payload, payload_size); break;
    case 2U: handle_withdraw(payload, payload_size); break;
    case 3U: handle_swap(payload, payload_size); break;
    default: tsdk_revert(ERR_BAD_INSTRUCTION);
  }
  tsdk_return(TSDK_SUCCESS);
}
