#!/usr/bin/env bash
# Build, test and (only when asked) upgrade the Heirloom Anchor program. Run inside WSL Ubuntu:
#
#   wsl -d Ubuntu -u tumo --cd ~ -- bash "/mnt/c/Users/tumom/Hackathons/W3Node Hacathon/scripts/build-program.sh" [test|idl|deploy]
#
#   test     (default) build, check the program id, cargo test. Changes no tracked file and needs no keypair or wallet.
#   idl      the same, then copy the checked IDL to app/src/lib/chain/idl/heirloom.json.
#   deploy   the same, then upgrade the devnet program by its id, after printing the size, the SOL needed and the
#            balance. It refuses when the balance is short. It never creates a program.
#            Since 25 Nov 2026 the upgrade authority is a 2-of-3 Squads multisig, so this mode refuses: build with
#            the verifiable image instead (docs/security-audit.md §4c), write a buffer, hand the buffer to the vault and
#            upgrade through scripts/squads/squads.mjs (propose, approve twice, execute after the time lock).
#
# The program id is the one below and nothing here can change it: keys are never synced and sources are never copied
# back (on a fresh clone, with no keypair, syncing keys would invent a new id and write it into the repo).
#
# Building on /mnt/c is slow, so the sources are mirrored to a work directory on the Linux disk.
#   HEIRLOOM_REPO    the checkout to build (default: the one this script is in)
#   HEIRLOOM_WORK    the work directory (default: ~/heirloom-build). Its programs/ folder is replaced on every run.
#   HEIRLOOM_WALLET  deploy only: the upgrade authority's wallet file (default: ~/.config/solana/id.json)
set -euo pipefail

export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.avm/bin:$HOME/.cargo/bin:$PATH"

PROGRAM_ID="b3PBVwkLnyx7eyLPNtc5J3Ds3os3cenqCVRHaCJM7FY"
DEVNET_GENESIS="EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
# The upgradeable loader's headers, and the least it lets a program grow by.
PROGRAMDATA_HEADER=45
BUFFER_HEADER=37
MIN_EXTEND=10240
IDL="target/idl/heirloom.json"
SO="target/deploy/heirloom.so"
APP_IDL="app/src/lib/chain/idl/heirloom.json"

die() { echo "!! $*" >&2; exit 1; }

MODE="${1:-test}"
[ "$#" -le 1 ] || die "too many arguments"
case "$MODE" in test|idl|deploy) ;; *) die "unknown mode '$MODE': use test, idl or deploy" ;; esac

REPO="${HEIRLOOM_REPO:-$(dirname "${BASH_SOURCE[0]}")/..}"
REPO="$(cd "$REPO" && pwd -P)"

check_sources() { # <root>
  local lib="$1/programs/heirloom/src/lib.rs" declared configured
  declared="$(sed -n 's/^[[:space:]]*declare_id!("\([^"]*\)").*/\1/p' "$lib")"
  [ "$declared" = "$PROGRAM_ID" ] || die "wrong program id in $lib: '$declared' (expected $PROGRAM_ID)"
  configured="$(sed -n 's/^[[:space:]]*heirloom[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$1/Anchor.toml" | LC_ALL=C sort -u)"
  [ "$configured" = "$PROGRAM_ID" ] || die "wrong program id in $1/Anchor.toml: '$configured' (expected $PROGRAM_ID)"
}

check_idl() { # <file>
  local address
  address="$(sed -n 's/^[[:space:]]*"address"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | sed -n 1p)"
  [ "$address" = "$PROGRAM_ID" ] || die "wrong program id in $1: '$address' (expected $PROGRAM_ID)"
}

echo "== check the program id in the checkout"
check_sources "$REPO"

WORK="${HEIRLOOM_WORK:-$HOME/heirloom-build}"
mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd -P)"
[ "$WORK" != "/" ] && [ "$WORK" != "$(cd "$HOME" && pwd -P)" ] || die "HEIRLOOM_WORK must be a directory of its own"
case "$WORK/" in "$REPO"/*) die "HEIRLOOM_WORK must be outside the checkout" ;; esac
case "$REPO/" in "$WORK"/*) die "HEIRLOOM_WORK must not contain the checkout" ;; esac
if [ -n "$(ls -A "$WORK")" ] && ! grep -qs '^[[:space:]]*heirloom[[:space:]]*=' "$WORK/Anchor.toml"; then
  die "$WORK is not empty and is not a Heirloom build directory"
fi

echo "== mirror sources to $WORK"
cp "$REPO/Anchor.toml" "$REPO/Cargo.toml" "$REPO/Cargo.lock" "$WORK/"
rm -rf "$WORK/programs"
cp -r "$REPO/programs" "$WORK/programs"
mkdir -p "$WORK/target/deploy"

cd "$WORK"
rm -f "$IDL" "$SO" # an older build's output must not pass the checks below
echo "== anchor build --ignore-keys"
anchor build --ignore-keys

echo "== check the program id in what was built"
check_sources "$WORK"
[ -f "$IDL" ] || die "the build wrote no IDL"
[ -f "$SO" ] || die "the build wrote no program"
check_idl "$IDL"

echo "== cargo test (LiteSVM)"
cargo test -p heirloom

echo "== copy build outputs to the checkout's gitignored target/"
mkdir -p "$REPO/target/deploy" "$REPO/target/idl"
cp "$SO" "$REPO/$SO"
cp "$IDL" "$REPO/$IDL"

if [ "$MODE" = "idl" ]; then
  echo "== copy the checked IDL to $APP_IDL"
  cp "$IDL" "$REPO/$APP_IDL"
elif ! cmp -s <(tr -d '\r' < "$IDL") <(tr -d '\r' < "$REPO/$APP_IDL"); then
  echo "!! $APP_IDL differs from this build: run this script with 'idl' to update it"
fi

BYTES="$(wc -c < "$SO" | tr -d ' ')"
echo "== program id: $PROGRAM_ID"
echo "== size: $BYTES bytes, sha256 $(sha256sum "$SO" | cut -d ' ' -f 1)"

[ "$MODE" = "deploy" ] || exit 0

# ------------------------------------------------------------------ deploy: an upgrade of the devnet program, by id
WALLET="${HEIRLOOM_WALLET:-$HOME/.config/solana/id.json}"
[ -f "$WALLET" ] || die "no wallet at $WALLET"

sol() { solana "$@" --url devnet --keypair "$WALLET"; }
number() { sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p"; }
text() { sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"; }
whole() { case "$2" in ''|*[!0-9]*) die "could not read $1" ;; esac; }
rent() { sol rent "$1" --output json-compact | number rentExemptMinimumLamports; }
in_sol() { printf '%d.%09d SOL' "$(($1 / 1000000000))" "$(($1 % 1000000000))"; }

[ "$(sol genesis-hash)" = "$DEVNET_GENESIS" ] || die "this RPC is not devnet"
SHOW="$(sol program show "$PROGRAM_ID" --output json-compact)" || die "program $PROGRAM_ID is not on devnet: this only upgrades"
SIGNER="$(sol address)"
AUTHORITY="$(printf '%s\n' "$SHOW" | text authority)"
[ "$AUTHORITY" = "$SIGNER" ] || die "this wallet ($SIGNER) is not the upgrade authority ($AUTHORITY)"

CURRENT="$(printf '%s\n' "$SHOW" | number dataLen)"; whole "the program's size" "$CURRENT"
HELD="$(printf '%s\n' "$SHOW" | number lamports)"; whole "the program's rent" "$HELD"

# An upgrade holds a second copy in a buffer until it lands, on top of any growth of the program's own account.
BUFFER="$(rent "$((BYTES + BUFFER_HEADER))")"; whole "the buffer's rent" "$BUFFER"
GROW=0
if [ "$BYTES" -gt "$CURRENT" ]; then
  CAPACITY=$((CURRENT + MIN_EXTEND))
  [ "$BYTES" -le "$CAPACITY" ] || CAPACITY="$BYTES"
  AFTER="$(rent "$((CAPACITY + PROGRAMDATA_HEADER))")"; whole "the larger program's rent" "$AFTER"
  [ "$AFTER" -le "$HELD" ] || GROW=$((AFTER - HELD))
fi
FEES=$(((BYTES / 900 + 10) * 10000))
NEED=$((BUFFER + GROW + FEES))
BALANCE="$(sol balance --lamports | sed -n 's/^\([0-9][0-9]*\).*/\1/p')"; whole "the balance" "$BALANCE"

echo "== upgrade $PROGRAM_ID on devnet"
echo "   size:     $BYTES bytes (the program account holds $CURRENT)"
echo "   needed:   $(in_sol "$NEED") (buffer $(in_sol "$BUFFER"), returned afterwards; growth $(in_sol "$GROW"); fees up to $(in_sol "$FEES"))"
echo "   balance:  $(in_sol "$BALANCE")"
[ "$BALANCE" -ge "$NEED" ] || die "short by $(in_sol "$((NEED - BALANCE))"): nothing was sent"

sol program deploy "$SO" --program-id "$PROGRAM_ID" --use-rpc
echo "== upgraded $PROGRAM_ID"
