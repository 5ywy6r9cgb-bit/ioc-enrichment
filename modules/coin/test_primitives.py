#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Known-vector tests for primitives.py.

    python3 test_primitives.py

Prints one PASS or FAIL line per check and exits 1 if any check fails.
Checks tagged [extra] go beyond the requested vectors: cross-checks against
hashlib, and edge cases from BIP-173, BIP-350 and RFC 8032.
"""
import hashlib
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import primitives as P  # noqa: E402

RESULTS = []  # (name, ok)


# ------------------------------------------------------------------ harness

def _show(v):
    """Readable form of a value for FAIL lines."""
    if isinstance(v, (bytes, bytearray)):
        return type(v).__name__ + ":" + v.hex()
    if isinstance(v, tuple):
        return "(" + ", ".join(_show(x) for x in v) + ")"
    return repr(v)


def _same(a, b) -> bool:
    """Equal and of the same type, recursively through tuples and lists."""
    if type(a) is not type(b):
        return False
    if isinstance(a, (tuple, list)):
        return len(a) == len(b) and all(_same(x, y) for x, y in zip(a, b))
    return a == b


def record(name: str, ok: bool, detail: str = "") -> None:
    """Store and print one result line."""
    RESULTS.append((name, ok))
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok or not detail else "  -- " + detail))


def check(name: str, fn, expected=True) -> None:
    """PASS if fn() returns expected (same type too); an exception is a FAIL."""
    try:
        got = fn()
    except Exception as exc:
        record(name, False, f"raised {type(exc).__name__}: {exc}")
        return
    record(name, _same(got, expected), f"got {_show(got)}, expected {_show(expected)}")


def check_raises(name: str, fn, exc_type=ValueError) -> None:
    """PASS if fn() raises exc_type."""
    try:
        fn()
    except exc_type:
        record(name, True)
    except Exception as exc:
        record(name, False, f"raised {type(exc).__name__} instead of {exc_type.__name__}: {exc}")
    else:
        record(name, False, "did not raise")


def flip_case_at(s: str, i: int) -> str:
    """s with the letter at index i switched to the other case."""
    ch = s[i]
    return s[:i] + (ch.lower() if ch.isupper() else ch.upper()) + s[i + 1:]


def flip_bit(b: bytes, byte_index: int, bit: int = 0) -> bytes:
    """b with one bit inverted."""
    out = bytearray(b)
    out[byte_index] ^= 1 << bit
    return bytes(out)


def sample(n: int) -> bytes:
    """Deterministic n-byte test input."""
    return bytes((i * 131 + 7) & 0xFF for i in range(n))


# ------------------------------------------------------------ SHA-256 [extra]

def test_sha256():
    check("sha256(b'abc') FIPS 180-2 vector [extra]", lambda: P.sha256(b"abc").hex(),
          "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    genesis_header = bytes.fromhex(
        "01000000" + "00" * 32
        + "3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a"
        + "29ab5f49" + "ffff001d" + "1dac2b7c")
    check("sha256d(genesis block header) = block hash [extra]", lambda: P.sha256d(genesis_header)[::-1].hex(),
          "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f")


# ---------------------------------------------------------------- Keccak-256

def test_keccak():
    check("keccak256(b'')", lambda: P.keccak256(b"").hex(),
          "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")
    check("keccak256(b'abc')", lambda: P.keccak256(b"abc").hex(),
          "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45")
    check("keccak256(b'Transfer(address,address,uint256)')",
          lambda: P.keccak256(b"Transfer(address,address,uint256)").hex(),
          "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef")

    def two_blocks():
        data = b"a" * 200
        out = P.keccak256(data)
        return type(out) is bytes and len(out) == 32 and out != hashlib.sha3_256(data).digest()
    check("keccak256(b'a'*200) runs, is 32 bytes, differs from sha3_256", two_blocks)

    def sponge_matches_sha3():
        lengths = (0, 1, 55, 56, 64, 134, 135, 136, 137, 200, 271, 272, 273, 500)
        bad = [n for n in lengths if P._keccak_sponge(sample(n), 0x06) != hashlib.sha3_256(sample(n)).digest()]
        return bad or True
    check("same permutation with SHA-3 padding equals hashlib.sha3_256 at block edges [extra]", sponge_matches_sha3)


# ------------------------------------------------------------------- EIP-55

EIP55_ADDRESSES = (
    "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
    "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
    "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
)


def test_eip55():
    for addr in EIP55_ADDRESSES:
        tag = addr[:8] + "..."
        check(f"EIP-55 {tag} to_checksum_address(lowercase) round-trips",
              lambda a=addr: P.to_checksum_address(a.lower()), addr)
        check(f"EIP-55 {tag} checksum_status == VALID", lambda a=addr: P.checksum_status(a), "VALID")
        letters = [i for i in range(2, 42) if addr[i].isalpha()]
        check(f"EIP-55 {tag} one-letter case flip -> INVALID (each of {len(letters)} letters)",
              lambda a=addr, idx=letters: [i for i in idx if P.checksum_status(flip_case_at(a, i)) != "INVALID"]
              or True)
        check(f"EIP-55 {tag} lowercase -> NO_CHECKSUM", lambda a=addr: P.checksum_status(a.lower()), "NO_CHECKSUM")

    addr = EIP55_ADDRESSES[0]
    body = addr[2:]
    check("EIP-55 accepts no prefix and uppercase input [extra]",
          lambda: P.to_checksum_address(body.upper()), addr)
    check("EIP-55 accepts a 0X prefix [extra]", lambda: P.to_checksum_address("0X" + body.lower()), addr)
    check("EIP-55 uppercase -> NO_CHECKSUM [extra]", lambda: P.checksum_status("0x" + body.upper()), "NO_CHECKSUM")
    malformed = {
        "39 hex chars": addr[:-1],
        "41 hex chars": addr + "0",
        "non-hex 'g'": "0x" + "g" + body[1:],
        "underscore": "0x" + "_" + body[1:],
        "inner space": "0x" + " " + body[1:],
        "empty": "",
        "None": None,
    }
    check("EIP-55 malformed inputs -> MALFORMED [extra]",
          lambda: [k for k, v in malformed.items() if P.checksum_status(v) != "MALFORMED"] or True)
    check_raises("EIP-55 to_checksum_address rejects 39 hex chars [extra]",
                 lambda: P.to_checksum_address(addr[:-1]))
    check_raises("EIP-55 to_checksum_address rejects a non-hex char [extra]",
                 lambda: P.to_checksum_address("0x" + "g" + body[1:]))


# ------------------------------------------------------ RIPEMD-160, hash160

RIPEMD_VECTORS = {
    b"": "9c1185a5c5e9fc54612808977ee8f548b2258d31",
    b"abc": "8eb208f7e05d987a9b044a8e98c6b087f15a0bfc",
}


def test_ripemd160():
    path = "hashlib" if P.HASHLIB_RIPEMD160 else "pure fallback"
    for msg, want in RIPEMD_VECTORS.items():
        check(f"ripemd160({msg!r}) via {path}", lambda m=msg: P.ripemd160(m).hex(), want)
        check(f"_ripemd160_pure({msg!r})", lambda m=msg: P._ripemd160_pure(m).hex(), want)

    def forced_fallback():
        saved = P.HASHLIB_RIPEMD160
        P.HASHLIB_RIPEMD160 = False
        try:
            return {m.hex(): P.ripemd160(m).hex() for m in RIPEMD_VECTORS} == \
                   {m.hex(): w for m, w in RIPEMD_VECTORS.items()}
        finally:
            P.HASHLIB_RIPEMD160 = saved
    check("ripemd160() with hashlib disabled uses the pure path and still matches [extra]", forced_fallback)

    def probe_without_ripemd():
        real_new = hashlib.new

        def no_ripemd(name, *args, **kwargs):
            if name.lower() == "ripemd160":
                raise ValueError("unsupported hash type ripemd160")
            return real_new(name, *args, **kwargs)
        hashlib.new = no_ripemd
        try:
            return P._hashlib_ripemd160_works()
        finally:
            hashlib.new = real_new
    check("hashlib probe reports False when OpenSSL lacks ripemd160 [extra]", probe_without_ripemd, False)

    if P.HASHLIB_RIPEMD160:
        check("_ripemd160_pure equals hashlib ripemd160 for every length 0..200 [extra]",
              lambda: [n for n in range(201)
                       if P._ripemd160_pure(sample(n)) != hashlib.new("ripemd160", sample(n)).digest()] or True)
    else:
        print("INFO  hashlib has no ripemd160 here; hashlib cross-check skipped")

    pubkey = bytes.fromhex(
        "04678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb6"
        "49f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5f")
    check("hash160(genesis uncompressed pubkey)", lambda: P.hash160(pubkey).hex(),
          "62e907b15cbf27d5425399ebf6f0fb50ebb88f18")


# -------------------------------------------------------------------- Base58

GENESIS_ADDR = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"
GENESIS_PAYLOAD = bytes.fromhex("00" + "62e907b15cbf27d5425399ebf6f0fb50ebb88f18")


def test_base58():
    check("b58check_decode(1A1zP1eP...) = 00 || hash160", lambda: P.b58check_decode(GENESIS_ADDR), GENESIS_PAYLOAD)
    check("b58check_encode(payload) gives 1A1zP1eP... back", lambda: P.b58check_encode(GENESIS_PAYLOAD), GENESIS_ADDR)
    check_raises("b58check_decode rejects a one-character change (last a -> b)",
                 lambda: P.b58check_decode(GENESIS_ADDR[:-1] + "b"))

    def every_position():
        missed = []
        for i, ch in enumerate(GENESIS_ADDR):
            mutated = GENESIS_ADDR[:i] + ("2" if ch != "2" else "3") + GENESIS_ADDR[i + 1:]
            try:
                P.b58check_decode(mutated)
                missed.append(i)
            except ValueError:
                pass
        return missed or True
    check(f"b58check_decode rejects a change at each of {len(GENESIS_ADDR)} positions [extra]", every_position)
    check_raises("b58check_decode rejects a non-alphabet character '0' [extra]",
                 lambda: P.b58check_decode("0" + GENESIS_ADDR[1:]))
    check("b58encode(b'Hello World!') [extra]", lambda: P.b58encode(b"Hello World!"), "2NEpo7TZRRrLZSi2U")
    check("b58encode/b58decode keep leading zero bytes as '1' [extra]",
          lambda: (P.b58encode(b"\x00\x00\x00\x01\x02"), P.b58decode(P.b58encode(b"\x00\x00\x00\x01\x02"))),
          ("111" + P.b58encode(b"\x01\x02"), b"\x00\x00\x00\x01\x02"))
    check("b58encode(b'') == '' and b58decode('') == b'' [extra]",
          lambda: (P.b58encode(b""), P.b58decode("")), ("", b""))


# ------------------------------------------------------ Bech32 / Bech32m

# VECTOR CORRECTION. The task stated this address as STATED_ADDR below. That string is a
# one-character typo of the published BIP-173 vector (c instead of y after "tdg4"):
#   * the program 751e76e8... converts to the 5-bit data "w508d6qejxtdg4y5r3zarvary0c5xw7k";
#   * STATED_ADDR fails both checksums (polymod 0x2fd229b1; valid is 1 or 0x2bc830a3);
#   * BIP-173 lists "BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4" -> 0014751e76e8...33bd6.
# The requested checks therefore run on the published string, and the stated string is
# checked to be rejected, so the discrepancy stays visible in every run.
STATED_ADDR = "bc1qw508d6qejxtdg4c5r3zarvary0c5xw7kv8f3t4"
BIP173_ADDR = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"
BIP173_PROG = bytes.fromhex("751e76e8199196d454941c45d1b3a323f1433bd6")


def test_bech32():
    check("segwit_decode('bc', bc1qw508d6qejxtdg4y5r3...) (BIP-173 published form)",
          lambda: P.segwit_decode("bc", BIP173_ADDR), (0, BIP173_PROG))
    check("segwit_decode('bc', BC1QW508D6QEJXTDG4Y5R3...) uppercase",
          lambda: P.segwit_decode("bc", BIP173_ADDR.upper()), (0, BIP173_PROG))
    mixed = flip_case_at(BIP173_ADDR, 4)  # bc1qW508...: valid except for the mixed case
    check_raises("segwit_decode rejects mixed case", lambda: P.segwit_decode("bc", mixed))
    check("bech32_decode(mixed case) -> (None, None, None)", lambda: P.bech32_decode(mixed), (None, None, None))
    check("stated vector ...tdg4c5r3... is one character off the BIP-173 string",
          lambda: [(i, a, b) for i, (a, b) in enumerate(zip(STATED_ADDR, BIP173_ADDR)) if a != b], [(18, "c", "y")])
    check_raises("stated vector ...tdg4c5r3... is rejected (bad checksum), as any correct decoder must",
                 lambda: P.segwit_decode("bc", STATED_ADDR))

    prog = P.sha256(b"a 32-byte witness program")

    def v1_roundtrip():
        addr = P.segwit_encode("bc", 1, prog)
        return addr.startswith("bc1p") and P.segwit_decode("bc", addr) == (1, prog)
    check("segwit v1, 32-byte program: encodes to bc1p... and round-trips", v1_roundtrip)
    v1_bech32 = P.bech32_encode("bc", [1] + P.convertbits(prog, 8, 5), P.BECH32)
    check("  (that v1 string built with a Bech32 checksum is itself valid Bech32)",
          lambda: P.bech32_decode(v1_bech32)[2], P.BECH32)
    check_raises("segwit_decode rejects v1 with a Bech32 (not M) checksum", lambda: P.segwit_decode("bc", v1_bech32))

    # [extra]
    check("segwit_encode('bc', 0, prog) == bc1qw508d6... [extra]",
          lambda: P.segwit_encode("bc", 0, BIP173_PROG), BIP173_ADDR)
    check("BIP-350 v1 vector bc1p0xlxvlhemja6... decodes [extra]",
          lambda: P.segwit_decode("bc", "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0"),
          (1, bytes.fromhex("79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798")))
    v0_bech32m = P.bech32_encode("bc", [0] + P.convertbits(BIP173_PROG, 8, 5), P.BECH32M)
    check_raises("segwit_decode rejects v0 with a Bech32m checksum [extra]", lambda: P.segwit_decode("bc", v0_bech32m))
    check_raises("segwit_decode rejects the wrong hrp [extra]", lambda: P.segwit_decode("tb", BIP173_ADDR))
    bad_programs = {"v17": (17, prog), "v0 21 bytes": (0, bytes(21)), "v1 1 byte": (1, b"\x01"),
                    "v1 41 bytes": (1, bytes(41))}
    for label, (ver, wp) in bad_programs.items():
        check_raises(f"segwit_encode rejects {label} [extra]", lambda v=ver, w=wp: P.segwit_encode("bc", v, w))

    spec_vectors = {  # BIP-173 and BIP-350 valid checksum strings
        "A12UEL5L": P.BECH32, "a12uel5l": P.BECH32, "?1ezyfcl": P.BECH32,
        "an83characterlonghumanreadablepartthatcontainsthenumber1andtheexcludedcharactersbio1tt5tgs": P.BECH32,
        "A1LQFN3A": P.BECH32M, "a1lqfn3a": P.BECH32M, "?1v759aa": P.BECH32M,
        "abcdef1l7aum6echk45nj3s0wdvt2fg8x9yrzpqzd3ryx": P.BECH32M,
    }
    check("BIP-173/BIP-350 checksum vectors decode as the right variant [extra]",
          lambda: [s for s, spec in spec_vectors.items() if P.bech32_decode(s)[2] != spec] or True)
    invalid = ["pzry9x0s0muk", "1pzry9x0s0muk", "x1b4n0q5v", "li1dgmt3", "A1G7SGD8", "\x201nwldj5", "de1lg7wt\xff"]
    check("BIP-173 invalid strings -> (None, None, None) [extra]",
          lambda: [s for s in invalid if P.bech32_decode(s) != (None, None, None)] or True)

    def length_limit():
        def build(n_values):
            data = [0] * n_values
            s = "a1" + "".join(P.BECH32_CHARSET[v] for v in data + P._bech32_create_checksum("a", data, P.BECH32))
            return s, data
        s90, _ = build(82)
        s91, data91 = build(83)
        checksum_ok = P._bech32_verify_checksum("a", [P.BECH32_CHARSET.find(c) for c in s91[2:]]) == P.BECH32
        return (len(s90), P.bech32_decode(s90)[2], len(s91), checksum_ok, P.bech32_decode(s91))
    check("90-char limit: 90 decodes; 91 with a correct checksum is refused [extra]", length_limit,
          (90, P.BECH32, 91, True, (None, None, None)))
    check_raises("bech32_encode refuses output over 90 characters [extra]",
                 lambda: P.bech32_encode("a", [0] * 83, P.BECH32))
    check("convertbits pad=False rejects non-zero or excess padding [extra]",
          lambda: (P.convertbits([0, 1], 5, 8, False), P.convertbits([31], 5, 8, False),
                   P.convertbits([0, 0], 5, 8, False)),
          (None, None, [0]))


# ------------------------------------------------------------------- Ed25519

RFC8032 = (
    ("TEST 1",
     "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
     "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
     "",
     "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155"
     "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"),
    ("TEST 2",
     "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
     "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
     "72",
     "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da"
     "085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"),
)


def test_ed25519():
    for name, sk_hex, pk_hex, msg_hex, sig_hex in RFC8032:
        sk, pk, msg, sig = (bytes.fromhex(h) for h in (sk_hex, pk_hex, msg_hex, sig_hex))
        check(f"Ed25519 RFC 8032 {name} public key", lambda s=sk: P.ed25519_public_key(s), pk)
        check(f"Ed25519 RFC 8032 {name} signature", lambda s=sk, m=msg: P.ed25519_sign(s, m), sig)
        check(f"Ed25519 RFC 8032 {name} verify, right message", lambda p=pk, m=msg, g=sig: P.ed25519_verify(p, m, g))
        if msg:
            check(f"Ed25519 {name} verify, flipped message bit -> False",
                  lambda p=pk, m=msg, g=sig: P.ed25519_verify(p, flip_bit(m, 0), g), False)
        else:
            check(f"Ed25519 {name} verify, changed message (empty -> b'\\x00'; no bit to flip) -> False",
                  lambda p=pk, g=sig: P.ed25519_verify(p, b"\x00", g), False)
        check(f"Ed25519 {name} verify, flipped signature bit in R -> False",
              lambda p=pk, m=msg, g=sig: P.ed25519_verify(p, m, flip_bit(g, 0)), False)
        check(f"Ed25519 {name} verify, flipped signature bit in S -> False",
              lambda p=pk, m=msg, g=sig: P.ed25519_verify(p, m, flip_bit(g, 32)), False)
        check(f"Ed25519 {name} verify, wrong-length signatures (63, 65, 0 bytes) -> False",
              lambda p=pk, m=msg, g=sig: (P.ed25519_verify(p, m, g[:-1]), P.ed25519_verify(p, m, g + b"\x00"),
                                          P.ed25519_verify(p, m, b"")), (False, False, False))

    # [extra]
    name, sk_hex, pk_hex, msg_hex, sig_hex = RFC8032[1]
    pk, msg, sig = bytes.fromhex(pk_hex), bytes.fromhex(msg_hex), bytes.fromhex(sig_hex)
    s = int.from_bytes(sig[32:], "little")
    sig_s_plus_l = sig[:32] + (s + P.ED25519_L).to_bytes(32, "little")
    check("Ed25519 verify rejects S + L (same point, S >= L) [extra]",
          lambda: P.ed25519_verify(pk, msg, sig_s_plus_l), False)
    garbage = {
        "pk None": (None, msg, sig), "pk str": ("x" * 32, msg, sig), "pk 31 bytes": (pk[:-1], msg, sig),
        "pk y >= p (all 0xff)": (b"\xff" * 32, msg, sig), "sig None": (pk, msg, None), "sig int": (pk, msg, 64),
        "sig str": (pk, msg, "z" * 64), "msg None": (pk, None, sig), "msg str": (pk, "r", sig),
        "R y >= p": (pk, msg, b"\xff" * 32 + sig[32:]),
    }

    def garbage_is_false():
        out = {}
        for label, args in garbage.items():
            out[label] = P.ed25519_verify(*args)  # an exception here fails the check
        return [k for k, v in out.items() if v is not False] or True
    check("Ed25519 verify returns False, never raises, on garbage inputs [extra]", garbage_is_false)

    def identity_r():
        # A signature whose R is the identity point (nonce 0) satisfies [S]B = R + [k]A with S = k*a.
        # Canonical R must verify; the same point written with y >= p, or as x = 0 with the sign
        # bit set, must be refused (RFC 8032 5.1.3), although the group equation would hold.
        sk, pk1 = bytes.fromhex(RFC8032[0][1]), bytes.fromhex(RFC8032[0][2])
        note, a = b"identity R", P._expand_seed(sk)[0]

        def sig_for(r_enc):
            k = int.from_bytes(hashlib.sha512(r_enc + pk1 + note).digest(), "little") % P.ED25519_L
            return r_enc + (k * a % P.ED25519_L).to_bytes(32, "little")
        encodings = (1, 1 + P.ED25519_P, 1 | (1 << 255))
        return tuple(P.ed25519_verify(pk1, note, sig_for(y.to_bytes(32, "little"))) for y in encodings)
    check("Ed25519 R = identity: canonical verifies; y >= p and signed x = 0 encodings refused [extra]",
          identity_r, (True, False, False))

    seed, other = P.sha256(b"seed one"), P.sha256(b"seed two")
    note = b"sign/verify round trip"

    def round_trip():
        sig1 = P.ed25519_sign(seed, note)
        return (len(sig1), P.ed25519_verify(P.ed25519_public_key(seed), note, sig1),
                P.ed25519_verify(P.ed25519_public_key(other), note, sig1),
                P.ed25519_verify(P.ed25519_public_key(seed), note, bytearray(sig1)))
    check("Ed25519 sign/verify round trip; other key rejects; bytearray accepted [extra]",
          round_trip, (64, True, False, True))
    check_raises("Ed25519 rejects a 64-byte secret key (seed expected) [extra]",
                 lambda: P.ed25519_public_key(bytes(64)))


# ---------------------------------------------------------------------- main

SECTIONS = (test_sha256, test_keccak, test_eip55, test_ripemd160, test_base58, test_bech32, test_ed25519)


def main() -> int:
    print(f"INFO  python {sys.version.split()[0]}; hashlib ripemd160 available: {P.HASHLIB_RIPEMD160}")
    for section in SECTIONS:
        try:
            section()
        except Exception as exc:  # a crash in setup code counts as a failure, then carry on
            record(f"{section.__name__} setup", False, f"raised {type(exc).__name__}: {exc}")
    failed = [name for name, ok in RESULTS if not ok]
    print(f"\nRESULT  {len(RESULTS) - len(failed)} passed, {len(failed)} failed, {len(RESULTS)} checks")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
