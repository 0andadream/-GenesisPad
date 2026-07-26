BASEDIR := $(CURDIR)/build
THRU_C_SDK_DIR ?= $(HOME)/.thru/sdk/c/thru-sdk

PROGRAM_SRC := genesis_amm.c genesis_amm_math.c

ifneq ($(filter test,$(MAKECMDGOALS)),test)
include $(THRU_C_SDK_DIR)/thru_c_program.mk
endif

.PHONY: test
test:
	mkdir -p build
	$(CC) -std=c17 -Wall -Wextra -Werror -O2 \
	  genesis_amm_math.c tests/math_test.c -o build/genesis-amm-math-test
	./build/genesis-amm-math-test
