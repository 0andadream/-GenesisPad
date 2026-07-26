# Build the ABI-compatible Genesis constant-product AMM for ThruVM.
$(call make-bin,genesis_amm,genesis_amm genesis_amm_math,,-ltn_sdk)
