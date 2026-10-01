# -*- coding: utf-8 -*-
"""Coin primitives in pure standard-library Python: hashes, address encodings, Ed25519.

    Hashes     sha256, sha256d, ripemd160, hash160, keccak256
    Ethereum   to_checksum_address, checksum_status                  (EIP-55)
    Base58     b58encode, b58decode, b58check_encode, b58check_decode
    Bech32     bech32_encode, bech32_decode, convertbits,
               segwit_encode, segwit_decode                          (BIP-173, BIP-350)
    Ed25519    ed25519_public_key, ed25519_sign, ed25519_verify      (RFC 8032)

Python 3.9+, no third-party packages, no network. Written for correctness and
readability, not speed. The Ed25519 code is not constant-time: use it to check
signatures and for test keys, not to sign with keys that guard real funds.
"""
import hashlib
from typing import Iterable, Optional

__all__ = [
    "sha256", "sha256d", "ripemd160", "hash160", "keccak256",
    "to_checksum_address", "checksum_status",
    "b58encode", "b58decode", "b58check_encode", "b58check_decode",
    "BECH32", "BECH32M", "bech32_encode", "bech32_decode", "convertbits",
    "segwit_encode", "segwit_decode",
    "ed25519_public_key", "ed25519_sign", "ed25519_verify",
]

_MASK32 = 0xFFFFFFFF
_MASK64 = 0xFFFFFFFFFFFFFFFF


def _to_bytes(b) -> bytes:
    """Copy a bytes-like object to bytes; TypeError for str, int and other non-buffers."""
    return memoryview(b).tobytes()


# ------------------------------------------------------------------ SHA-256

def sha256(b: bytes) -> bytes:
    """SHA-256 digest (32 bytes)."""
    return hashlib.sha256(b).digest()


def sha256d(b: bytes) -> bytes:
    """Double SHA-256, sha256(sha256(b)), as used for Bitcoin ids and Base58Check."""
    return sha256(sha256(b))


# --------------------------------------------------------------- RIPEMD-160

_RMD_INIT = (0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0)
_RMD_K_LEFT = (0x00000000, 0x5A827999, 0x6ED9EBA1, 0x8F1BBCDC, 0xA953FD4E)
_RMD_K_RIGHT = (0x50A28BE6, 0x5C4DD124, 0x6D703EF3, 0x7A6D76E9, 0x00000000)
_RMD_WORD_LEFT = (
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8,
    3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12,
    1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2,
    4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13,
)
_RMD_WORD_RIGHT = (
    5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12,
    6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2,
    15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13,
    8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14,
    12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11,
)
_RMD_ROT_LEFT = (
    11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8,
    7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12,
    11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5,
    11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12,
    9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6,
)
_RMD_ROT_RIGHT = (
    8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6,
    9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11,
    9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5,
    15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8,
    8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11,
)
_RIPEMD160_EMPTY_HEX = "9c1185a5c5e9fc54612808977ee8f548b2258d31"


def _rol32(x: int, n: int) -> int:
    """Rotate the low 32 bits of x left by n."""
    x &= _MASK32
    return ((x << n) | (x >> (32 - n))) & _MASK32


def _rmd_f(group: int, x: int, y: int, z: int) -> int:
    """RIPEMD-160 boolean function for round group 0..4."""
    if group == 0:
        v = x ^ y ^ z
    elif group == 1:
        v = (x & y) | (~x & z)
    elif group == 2:
        v = (x | ~y) ^ z
    elif group == 3:
        v = (x & z) | (y & ~z)
    else:
        v = x ^ (y | ~z)
    return v & _MASK32


def _rmd_compress(h: tuple, block: bytes) -> tuple:
    """Run both RIPEMD-160 lines over one 64-byte block and fold them into the state."""
    x = [int.from_bytes(block[4 * i:4 * i + 4], "little") for i in range(16)]
    al, bl, cl, dl, el = h
    ar, br, cr, dr, er = h
    for j in range(80):
        g = j // 16
        t = _rol32(al + _rmd_f(g, bl, cl, dl) + x[_RMD_WORD_LEFT[j]] + _RMD_K_LEFT[g], _RMD_ROT_LEFT[j])
        al, bl, cl, dl, el = el, (t + el) & _MASK32, bl, _rol32(cl, 10), dl
        t = _rol32(ar + _rmd_f(4 - g, br, cr, dr) + x[_RMD_WORD_RIGHT[j]] + _RMD_K_RIGHT[g], _RMD_ROT_RIGHT[j])
        ar, br, cr, dr, er = er, (t + er) & _MASK32, br, _rol32(cr, 10), dr
    return (
        (h[1] + cl + dr) & _MASK32,
        (h[2] + dl + er) & _MASK32,
        (h[3] + el + ar) & _MASK32,
        (h[4] + al + br) & _MASK32,
        (h[0] + bl + cr) & _MASK32,
    )


def _ripemd160_pure(b: bytes) -> bytes:
    """Pure-Python RIPEMD-160, used when hashlib lacks it (e.g. OpenSSL 3 without legacy)."""
    data = _to_bytes(b)
    bit_len = (8 * len(data)) & _MASK64
    data += b"\x80" + b"\x00" * ((55 - len(data)) % 64) + bit_len.to_bytes(8, "little")
    h = _RMD_INIT
    for off in range(0, len(data), 64):
        h = _rmd_compress(h, data[off:off + 64])
    return b"".join(v.to_bytes(4, "little") for v in h)


def _hashlib_ripemd160_works() -> bool:
    """True if hashlib.new('ripemd160') exists here and gives the right empty-string digest."""
    try:
        return hashlib.new("ripemd160", b"").hexdigest() == _RIPEMD160_EMPTY_HEX
    except Exception:  # any failure means "not available"
        return False


HASHLIB_RIPEMD160 = _hashlib_ripemd160_works()


def ripemd160(b: bytes) -> bytes:
    """RIPEMD-160 digest (20 bytes): hashlib when it works, else _ripemd160_pure."""
    if HASHLIB_RIPEMD160:
        return hashlib.new("ripemd160", b).digest()
    return _ripemd160_pure(b)


def hash160(b: bytes) -> bytes:
    """ripemd160(sha256(b)): the 20-byte key hash in P2PKH and P2WPKH addresses."""
    return ripemd160(sha256(b))


# ---------------------------------------------------------------- Keccak-256

KECCAK256_RATE = 136  # bytes absorbed per permutation (1088 bits); capacity 512 bits

_KECCAK_ROUND_CONSTANTS = (
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
)
_KECCAK_ROTATIONS = (  # rho offsets, lane index x + 5*y
    0, 1, 62, 28, 27,
    36, 44, 6, 55, 20,
    3, 10, 43, 25, 39,
    41, 45, 15, 21, 8,
    18, 2, 61, 56, 14,
)


def _rol64(x: int, n: int) -> int:
    """Rotate a 64-bit lane left by n."""
    return ((x << n) | (x >> (64 - n))) & _MASK64


def _keccak_f1600(a: list) -> None:
    """Keccak-f[1600] permutation, in place, on 25 lanes indexed x + 5*y."""
    for rc in _KECCAK_ROUND_CONSTANTS:
        # theta: xor each lane with the parities of two neighbouring columns
        c = [a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20] for x in range(5)]
        d = [c[(x - 1) % 5] ^ _rol64(c[(x + 1) % 5], 1) for x in range(5)]
        for i in range(25):
            a[i] ^= d[i % 5]
        # rho and pi: rotate each lane, move (x, y) -> (y, 2x + 3y)
        b = [0] * 25
        for x in range(5):
            for y in range(5):
                b[y + 5 * ((2 * x + 3 * y) % 5)] = _rol64(a[x + 5 * y], _KECCAK_ROTATIONS[x + 5 * y])
        # chi: the only non-linear step, row by row
        for y in range(0, 25, 5):
            for x in range(5):
                a[y + x] = b[y + x] ^ (~b[y + (x + 1) % 5] & b[y + (x + 2) % 5])
        # iota
        a[0] ^= rc


def _keccak_sponge(data: bytes, domain: int, rate: int = KECCAK256_RATE, out_len: int = 32) -> bytes:
    """Keccak sponge with pad10*1. domain 0x01 = original Keccak (Ethereum); 0x06 = FIPS 202 SHA-3.

    rate must be a multiple of 8 and out_len at most rate (a single squeeze).
    """
    msg = _to_bytes(data)
    padded = bytearray(msg)
    padded += bytes(rate - len(msg) % rate)   # 1..rate bytes of padding
    padded[len(msg)] ^= domain
    padded[-1] ^= 0x80                        # same byte as the domain bits when one pad byte fits
    state = [0] * 25
    for off in range(0, len(padded), rate):
        for i in range(rate // 8):
            state[i] ^= int.from_bytes(padded[off + 8 * i:off + 8 * i + 8], "little")
        _keccak_f1600(state)
    return b"".join(lane.to_bytes(8, "little") for lane in state[:rate // 8])[:out_len]


def keccak256(b: bytes) -> bytes:
    """Ethereum Keccak-256: original Keccak padding (0x01), NOT hashlib.sha3_256 (0x06)."""
    return _keccak_sponge(b, 0x01)


# ------------------------------------------------------------- EIP-55 checksum

_HEX_CHARS = frozenset("0123456789abcdefABCDEF")


def _address_hex(addr) -> Optional[str]:
    """The 40 hex characters of an address with or without 0x/0X, or None if malformed."""
    if not isinstance(addr, str):
        return None
    body = addr[2:] if addr[:2] in ("0x", "0X") else addr
    if len(body) != 40 or not all(ch in _HEX_CHARS for ch in body):
        return None
    return body


def to_checksum_address(addr: str) -> str:
    """EIP-55: return '0x' + the mixed-case checksummed address. ValueError unless 40 hex chars."""
    body = _address_hex(addr)
    if body is None:
        raise ValueError(f"not a 20-byte hex address: {addr!r}")
    lower = body.lower()
    digest = keccak256(lower.encode("ascii")).hex()
    return "0x" + "".join(
        ch.upper() if ch in "abcdef" and int(digest[i], 16) >= 8 else ch for i, ch in enumerate(lower))


def checksum_status(addr: str) -> str:
    """Classify an address: VALID, INVALID (mixed case, wrong), NO_CHECKSUM (one case) or MALFORMED."""
    body = _address_hex(addr)
    if body is None:
        return "MALFORMED"
    if body == body.lower() or body == body.upper():
        return "NO_CHECKSUM"
    return "VALID" if to_checksum_address(body) == "0x" + body else "INVALID"


# -------------------------------------------------------------------- Base58

B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_B58_INDEX = {ch: i for i, ch in enumerate(B58_ALPHABET)}


def b58encode(b: bytes) -> str:
    """Base58 with the Bitcoin alphabet; each leading zero byte becomes '1'."""
    data = _to_bytes(b)
    n = int.from_bytes(data, "big")
    digits = []
    while n:
        n, rem = divmod(n, 58)
        digits.append(B58_ALPHABET[rem])
    zeros = len(data) - len(data.lstrip(b"\x00"))
    return "1" * zeros + "".join(reversed(digits))


def b58decode(s: str) -> bytes:
    """Inverse of b58encode; each leading '1' becomes a zero byte. ValueError on a bad character."""
    if not isinstance(s, str):
        raise TypeError("b58decode expects str")
    n = 0
    for ch in s:
        digit = _B58_INDEX.get(ch)
        if digit is None:
            raise ValueError(f"invalid base58 character {ch!r}")
        n = n * 58 + digit
    zeros = len(s) - len(s.lstrip("1"))
    return b"\x00" * zeros + n.to_bytes((n.bit_length() + 7) // 8, "big")


def b58check_encode(payload: bytes) -> str:
    """Base58Check: Base58 of payload + the first 4 bytes of sha256d(payload)."""
    data = _to_bytes(payload)
    return b58encode(data + sha256d(data)[:4])


def b58check_decode(s: str) -> bytes:
    """Decode Base58Check and return the payload. ValueError on a bad character or checksum."""
    raw = b58decode(s)
    if len(raw) < 4:
        raise ValueError("base58check string too short")
    payload, check = raw[:-4], raw[-4:]
    if sha256d(payload)[:4] != check:
        raise ValueError("base58check checksum mismatch")
    return payload


# ------------------------------------------------------ Bech32 and Bech32m

BECH32 = 1
BECH32M = 2
BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
BECH32M_CONST = 0x2BC830A3
BECH32_MAX_LENGTH = 90
_BECH32_GENERATOR = (0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3)
_BECH32_CONSTS = {BECH32: 1, BECH32M: BECH32M_CONST}


def _bech32_polymod(values: Iterable[int]) -> int:
    """BCH checksum polymod over GF(32), as in the BIP-173 reference."""
    chk = 1
    for v in values:
        top = chk >> 25
        chk = ((chk & 0x1FFFFFF) << 5) ^ v
        for i in range(5):
            if (top >> i) & 1:
                chk ^= _BECH32_GENERATOR[i]
    return chk


def _bech32_hrp_expand(hrp: str) -> list:
    """High bits of each hrp character, a zero, then the low bits."""
    return [ord(ch) >> 5 for ch in hrp] + [0] + [ord(ch) & 31 for ch in hrp]


def _bech32_create_checksum(hrp: str, data: list, spec: int) -> list:
    """The six 5-bit checksum values for hrp and data under BECH32 or BECH32M."""
    polymod = _bech32_polymod(_bech32_hrp_expand(hrp) + list(data) + [0] * 6) ^ _BECH32_CONSTS[spec]
    return [(polymod >> 5 * (5 - i)) & 31 for i in range(6)]


def _bech32_verify_checksum(hrp: str, data: list) -> Optional[int]:
    """BECH32 or BECH32M if data (checksum included) verifies, else None."""
    const = _bech32_polymod(_bech32_hrp_expand(hrp) + list(data))
    if const == 1:
        return BECH32
    if const == BECH32M_CONST:
        return BECH32M
    return None


def bech32_encode(hrp: str, data: list[int], spec: int) -> str:
    """Encode an hrp and 5-bit values as lowercase Bech32 or Bech32m. ValueError on bad input.

    Refuses anything bech32_decode would reject: an empty or non-printable hrp,
    values outside 0..31, or a result longer than 90 characters.
    """
    if spec not in _BECH32_CONSTS:
        raise ValueError("spec must be BECH32 or BECH32M")
    if not isinstance(hrp, str) or not hrp or any(not 33 <= ord(ch) <= 126 for ch in hrp):
        raise ValueError("hrp must be one or more printable ASCII characters")
    values = list(data)
    if any(not isinstance(v, int) or not 0 <= v <= 31 for v in values):
        raise ValueError("data values must be integers 0..31")
    hrp = hrp.lower()  # BIP-173: encoders output lowercase; the checksum covers the lowercase hrp
    out = hrp + "1" + "".join(BECH32_CHARSET[v] for v in values + _bech32_create_checksum(hrp, values, spec))
    if len(out) > BECH32_MAX_LENGTH:
        raise ValueError(f"bech32 string would be {len(out)} characters (limit {BECH32_MAX_LENGTH})")
    return out


def bech32_decode(s: str) -> tuple[Optional[str], Optional[list[int]], Optional[int]]:
    """Decode Bech32/Bech32m -> (hrp, data without checksum, spec), or (None, None, None).

    Reference behaviour: printable ASCII only, no mixed case, at most 90
    characters, a non-empty hrp before the last '1' and a 6-character checksum.
    """
    if not isinstance(s, str):
        return (None, None, None)
    if any(ord(ch) < 33 or ord(ch) > 126 for ch in s) or (s.lower() != s and s.upper() != s):
        return (None, None, None)
    s = s.lower()
    pos = s.rfind("1")
    if pos < 1 or pos + 7 > len(s) or len(s) > BECH32_MAX_LENGTH:
        return (None, None, None)
    if not all(ch in BECH32_CHARSET for ch in s[pos + 1:]):
        return (None, None, None)
    hrp = s[:pos]
    data = [BECH32_CHARSET.find(ch) for ch in s[pos + 1:]]
    spec = _bech32_verify_checksum(hrp, data)
    if spec is None:
        return (None, None, None)
    return (hrp, data[:-6], spec)


def convertbits(data: Iterable[int], frombits: int, tobits: int, pad: bool = True) -> Optional[list[int]]:
    """Regroup frombits-bit values into tobits-bit values (reference implementation).

    Returns None if a value is out of range, or, with pad=False, if the leftover
    bits are non-zero or amount to a whole input group.
    """
    acc = 0
    bits = 0
    ret = []
    maxv = (1 << tobits) - 1
    max_acc = (1 << (frombits + tobits - 1)) - 1
    for value in data:
        if value < 0 or (value >> frombits):
            return None
        acc = ((acc << frombits) | value) & max_acc
        bits += frombits
        while bits >= tobits:
            bits -= tobits
            ret.append((acc >> bits) & maxv)
    if pad:
        if bits:
            ret.append((acc << (tobits - bits)) & maxv)
    elif bits >= frombits or ((acc << (tobits - bits)) & maxv):
        return None
    return ret


def _check_witness(witver: int, prog: bytes) -> None:
    """ValueError unless version 0..16, program 2..40 bytes, and a v0 program is 20 or 32 bytes."""
    if not isinstance(witver, int) or not 0 <= witver <= 16:
        raise ValueError(f"witness version must be 0..16, got {witver!r}")
    if not 2 <= len(prog) <= 40:
        raise ValueError(f"witness program must be 2..40 bytes, got {len(prog)}")
    if witver == 0 and len(prog) not in (20, 32):
        raise ValueError(f"v0 witness program must be 20 or 32 bytes, got {len(prog)}")


def segwit_encode(hrp: str, witver: int, witprog: bytes) -> str:
    """Encode a segwit address: v0 with Bech32, v1..v16 with Bech32m. ValueError if invalid."""
    prog = _to_bytes(witprog)
    _check_witness(witver, prog)
    spec = BECH32 if witver == 0 else BECH32M
    addr = bech32_encode(hrp, [witver] + convertbits(prog, 8, 5), spec)
    segwit_decode(hrp, addr)  # the reference encoder's self-check; raises ValueError if unusable
    return addr


def segwit_decode(hrp: str, addr: str) -> tuple[int, bytes]:
    """Decode a segwit address for hrp -> (witness version, program). ValueError if invalid.

    Enforces BIP-173/BIP-350: v0 must use Bech32 and v1..v16 Bech32m; the
    program is 2..40 bytes, and 20 or 32 bytes for v0.
    """
    hrp_got, data, spec = bech32_decode(addr)
    if hrp_got is None:
        raise ValueError("not a valid Bech32/Bech32m string")
    if not isinstance(hrp, str) or hrp_got != hrp.lower():
        raise ValueError(f"hrp mismatch: expected {hrp!r}, got {hrp_got!r}")
    if not data:
        raise ValueError("missing witness version")
    witver = data[0]
    prog = convertbits(data[1:], 5, 8, False)
    if prog is None:
        raise ValueError("invalid witness program padding")
    prog = bytes(prog)
    _check_witness(witver, prog)
    if (witver == 0 and spec != BECH32) or (witver != 0 and spec != BECH32M):
        wanted = "Bech32" if witver == 0 else "Bech32m"
        raise ValueError(f"witness version {witver} must use a {wanted} checksum")
    return witver, prog


# ------------------------------------------------------------------- Ed25519

ED25519_P = 2 ** 255 - 19                                          # field prime
ED25519_L = 2 ** 252 + 27742317777372353535851937790883648493      # prime order of the base point
ED25519_D = -121665 * pow(121666, ED25519_P - 2, ED25519_P) % ED25519_P
_ED25519_SQRT_M1 = pow(2, (ED25519_P - 1) // 4, ED25519_P)          # a square root of -1 mod p
_ED25519_IDENTITY = (0, 1, 1, 0)

# Points use extended coordinates (X, Y, Z, T) with x = X/Z, y = Y/Z, x*y = T/Z.


def _pt_add(p1: tuple, p2: tuple) -> tuple:
    """Add two points (complete formula for a = -1; also doubles)."""
    p = ED25519_P
    x1, y1, z1, t1 = p1
    x2, y2, z2, t2 = p2
    a = (y1 - x1) * (y2 - x2) % p
    b = (y1 + x1) * (y2 + x2) % p
    c = 2 * t1 * t2 * ED25519_D % p
    d = 2 * z1 * z2 % p
    e, f, g, h = b - a, d - c, d + c, b + a
    return (e * f % p, g * h % p, f * g % p, e * h % p)


def _pt_mul(s: int, pt: tuple) -> tuple:
    """Scalar multiplication s*pt by double-and-add (not constant-time)."""
    q = _ED25519_IDENTITY
    while s > 0:
        if s & 1:
            q = _pt_add(q, pt)
        pt = _pt_add(pt, pt)
        s >>= 1
    return q


def _pt_equal(p1: tuple, p2: tuple) -> bool:
    """Projective equality: X1*Z2 == X2*Z1 and Y1*Z2 == Y2*Z1."""
    p = ED25519_P
    return (p1[0] * p2[2] - p2[0] * p1[2]) % p == 0 and (p1[1] * p2[2] - p2[1] * p1[2]) % p == 0


def _recover_x(y: int, sign: int) -> Optional[int]:
    """x for a y-coordinate with the given low bit (RFC 8032 5.1.3), or None if there is none."""
    p = ED25519_P
    if y >= p:
        return None                                   # non-canonical y
    x2 = (y * y - 1) * pow(ED25519_D * y * y + 1, p - 2, p) % p
    if x2 == 0:
        return None if sign else 0                    # x = 0 has no negative form
    x = pow(x2, (p + 3) // 8, p)
    if (x * x - x2) % p != 0:
        x = x * _ED25519_SQRT_M1 % p
    if (x * x - x2) % p != 0:
        return None                                   # not on the curve
    if (x & 1) != sign:
        x = p - x
    return x


def _pt_compress(pt: tuple) -> bytes:
    """32-byte encoding: little-endian y with the low bit of x in the top bit."""
    p = ED25519_P
    zinv = pow(pt[2], p - 2, p)
    x = pt[0] * zinv % p
    y = pt[1] * zinv % p
    return (y | ((x & 1) << 255)).to_bytes(32, "little")


def _pt_decompress(s: bytes) -> Optional[tuple]:
    """Decode a 32-byte point, or None if it is not a canonical curve point."""
    if len(s) != 32:
        return None
    y = int.from_bytes(s, "little")
    sign = y >> 255
    y &= (1 << 255) - 1
    x = _recover_x(y, sign)
    if x is None:
        return None
    return (x, y, 1, x * y % ED25519_P)


def _base_point() -> tuple:
    """The standard base point B: y = 4/5 with even x."""
    y = 4 * pow(5, ED25519_P - 2, ED25519_P) % ED25519_P
    x = _recover_x(y, 0)
    return (x, y, 1, x * y % ED25519_P)


ED25519_B = _base_point()


def _sha512_mod_l(data: bytes) -> int:
    """SHA-512 as a little-endian integer mod L."""
    return int.from_bytes(hashlib.sha512(data).digest(), "little") % ED25519_L


def _expand_seed(sk: bytes) -> tuple:
    """Clamped secret scalar and nonce prefix from a 32-byte seed."""
    seed = _to_bytes(sk)
    if len(seed) != 32:
        raise ValueError(f"Ed25519 secret key must be the 32-byte seed, got {len(seed)} bytes "
                         "(a 64-byte key is usually seed + public key: pass the first 32)")
    h = hashlib.sha512(seed).digest()
    a = int.from_bytes(h[:32], "little")
    a &= (1 << 254) - 8
    a |= 1 << 254
    return a, h[32:]


def ed25519_public_key(sk: bytes) -> bytes:
    """32-byte public key for a 32-byte seed."""
    a, _ = _expand_seed(sk)
    return _pt_compress(_pt_mul(a, ED25519_B))


def ed25519_sign(sk: bytes, msg: bytes) -> bytes:
    """Deterministic 64-byte signature R || S of msg under a 32-byte seed."""
    a, prefix = _expand_seed(sk)
    m = _to_bytes(msg)
    pk = _pt_compress(_pt_mul(a, ED25519_B))
    r = _sha512_mod_l(prefix + m)
    r_enc = _pt_compress(_pt_mul(r, ED25519_B))
    k = _sha512_mod_l(r_enc + pk + m)
    s = (r + k * a) % ED25519_L
    return r_enc + s.to_bytes(32, "little")


def ed25519_verify(pk: bytes, msg: bytes, sig: bytes) -> bool:
    """True only for a valid signature; False, never an exception, for anything else.

    RFC 8032 5.1.7: rejects S >= L and non-canonical or off-curve R and A, then
    checks [S]B == R + [k]A (the cofactorless form the RFC allows). Like the RFC,
    it does not reject small-order public keys.
    """
    try:
        pk, msg, sig = _to_bytes(pk), _to_bytes(msg), _to_bytes(sig)
        if len(pk) != 32 or len(sig) != 64:
            return False
        s = int.from_bytes(sig[32:], "little")
        if s >= ED25519_L:
            return False
        a_pt = _pt_decompress(pk)
        r_pt = _pt_decompress(sig[:32])
        if a_pt is None or r_pt is None:
            return False
        k = _sha512_mod_l(sig[:32] + pk + msg)
        return _pt_equal(_pt_mul(s, ED25519_B), _pt_add(r_pt, _pt_mul(k, a_pt)))
    except Exception:  # fail closed: garbage input is simply not a valid signature
        return False
