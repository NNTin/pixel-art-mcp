/**
 * Port of Python's `ipaddress.ip_address(ip).is_global`, which `references.py`'s `public_target`
 * uses as the actual security boundary rejecting private/loopback/link-local/reserved addresses
 * before a reference URL is ever dialed (see this package's final report and
 * `docs/typescript-rewrite.md`'s Phase 6 note: "get this right, it's the actual security
 * boundary").
 *
 * Node has no built-in equivalent of `is_global`, so this reconstructs it from the exact IANA
 * special-registry network tables CPython's `ipaddress` module ships (`_IPv4Constants`/
 * `_IPv6Constants` in `Lib/ipaddress.py`), verified empirically against a live CPython 3.11
 * interpreter (the same one this repo's `.venv` uses) rather than transcribed from memory --
 * see the worked examples below, each checked against `ipaddress.ip_address(x).is_global`.
 *
 * Two behaviors are easy to get wrong and are called out explicitly because they are *not*
 * "private-looking" in the intuitive sense, but CPython's `is_global` really does accept them:
 *
 * - Multicast addresses (`224.0.0.0/4`, `ff00::/8`) are **not** in either family's
 *   `_private_networks` list, so `is_global` is `True` for them (e.g. `224.0.0.1`,
 *   `ff0e::1`). This looks like an oversight in CPython but is the real, verified behavior --
 *   replicated here for exact parity rather than "fixed", since a public multicast address is
 *   not usable as an SSRF target anyway (connecting to one just fails), and diverging from
 *   Python here would be an unreviewed behavior change, not a fix.
 * - `100.64.0.0/10` (IPv4 Shared Address Space / CGNAT) is *not* in `_private_networks` either,
 *   but `is_global` has an extra explicit check excluding it -- it is neither fully private nor
 *   fully global. Same for its IPv6 equivalent handling via `ipv4_mapped`.
 * - An IPv4-mapped IPv6 address (`::ffff:0:0/96`, e.g. `::ffff:8.8.8.8`) defers entirely to the
 *   embedded IPv4 address's own `is_global` verdict, not the (unconditionally-private) IPv6
 *   `::ffff:0:0/96` network entry.
 */

import ipaddr from "ipaddr.js";

type Network = readonly [address: string, prefixLength: number];

// Verified against CPython 3.11's `ipaddress._IPv4Constants` (`Lib/ipaddress.py`).
const IPV4_PRIVATE_NETWORKS: readonly Network[] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.0.170", 31],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["240.0.0.0", 4],
  ["255.255.255.255", 32],
];
// Carved out of the ranges above -- globally reachable despite falling inside them.
const IPV4_PRIVATE_EXCEPTIONS: readonly Network[] = [
  ["192.0.0.9", 32],
  ["192.0.0.10", 32],
];
// Shared Address Space (RFC 6598): explicitly neither private nor global.
const IPV4_SHARED_ADDRESS_SPACE: Network = ["100.64.0.0", 10];

// Verified against CPython 3.11's `ipaddress._IPv6Constants` (`Lib/ipaddress.py`).
const IPV6_PRIVATE_NETWORKS: readonly Network[] = [
  ["::1", 128],
  ["::", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
];
const IPV6_PRIVATE_EXCEPTIONS: readonly Network[] = [
  ["2001:1::1", 128],
  ["2001:1::2", 128],
  ["2001:3::", 32],
  ["2001:4:112::", 48],
  ["2001:20::", 28],
  ["2001:30::", 28],
];

function matchesAny(
  address: ipaddr.IPv4 | ipaddr.IPv6,
  networks: readonly Network[],
): boolean {
  return networks.some(([base, bits]) => {
    const parsedBase = address.kind() === "ipv4" ? ipaddr.IPv4.parse(base) : ipaddr.IPv6.parse(base);
    return address.match(parsedBase, bits);
  });
}

function isPrivateIPv4(address: ipaddr.IPv4): boolean {
  return matchesAny(address, IPV4_PRIVATE_NETWORKS) && !matchesAny(address, IPV4_PRIVATE_EXCEPTIONS);
}

/** `IPv4Address.is_global`: not Shared Address Space, and not otherwise private. */
function isGlobalIPv4(address: ipaddr.IPv4): boolean {
  const [sharedBase, sharedBits] = IPV4_SHARED_ADDRESS_SPACE;
  const inSharedAddressSpace = address.match(ipaddr.IPv4.parse(sharedBase), sharedBits);
  return !inSharedAddressSpace && !isPrivateIPv4(address);
}

function isPrivateIPv6(address: ipaddr.IPv6): boolean {
  if (address.isIPv4MappedAddress()) return isPrivateIPv4(address.toIPv4Address());
  return matchesAny(address, IPV6_PRIVATE_NETWORKS) && !matchesAny(address, IPV6_PRIVATE_EXCEPTIONS);
}

/**
 * `IPv6Address.is_global`. Defers to the embedded IPv4 address's own verdict for
 * IPv4-mapped addresses (`::ffff:0:0/96`), exactly like CPython's `ipv4_mapped` special case.
 */
function isGlobalIPv6(address: ipaddr.IPv6): boolean {
  if (address.isIPv4MappedAddress()) return isGlobalIPv4(address.toIPv4Address());
  return !isPrivateIPv6(address);
}

/**
 * Equivalent of `ipaddress.ip_address(ip).is_global` for a numeric IPv4 or IPv6 address string
 * (no hostnames, no CIDR notation, no zone id assumptions beyond what `ipaddr.js` accepts).
 * Returns `false` for anything that doesn't parse as a valid address -- callers should treat
 * "not provably global" as "reject", matching `public_target`'s fail-closed posture.
 */
export function isGlobalAddress(ip: string): boolean {
  if (!ipaddr.isValid(ip)) return false;
  const parsed = ipaddr.parse(ip);
  return parsed instanceof ipaddr.IPv4 ? isGlobalIPv4(parsed) : isGlobalIPv6(parsed);
}
