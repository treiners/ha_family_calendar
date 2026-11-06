# shellcheck shell=bash
log_header "Running calendar card tests"
node --test tests/card/*.test.cjs
