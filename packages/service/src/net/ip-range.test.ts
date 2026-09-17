import { describe, expect, it } from "vitest";
import { isGlobalAddress } from "./ip-range.js";

// Every expected value below was checked against a live CPython 3.11 interpreter running
// `ipaddress.ip_address(x).is_global` (the same interpreter this repo's `.venv` uses) -- see
// `ip-range.ts`'s module doc comment for the two "surprising but verified" behaviors
// (multicast reads as global; 100.64.0.0/10 does not).
describe("isGlobalAddress", () => {
  it("rejects IPv4 private/loopback/link-local/reserved ranges", () => {
    for (const ip of [
      "0.0.0.0",
      "10.1.2.3",
      "127.0.0.1",
      "169.254.1.1",
      "172.16.5.5",
      "192.0.0.1",
      "192.0.2.5",
      "192.168.1.1",
      "198.18.0.1",
      "198.51.100.5",
      "203.0.113.5",
      "240.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isGlobalAddress(ip)).toBe(false);
    }
  });

  it("rejects IPv4 Shared Address Space (100.64.0.0/10), distinct from is_private", () => {
    expect(isGlobalAddress("100.64.0.1")).toBe(false);
    expect(isGlobalAddress("100.100.100.100")).toBe(false);
    expect(isGlobalAddress("100.127.255.255")).toBe(false);
  });

  it("accepts real public IPv4 addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "198.20.0.1"]) {
      expect(isGlobalAddress(ip)).toBe(true);
    }
  });

  it("carves out the two documented exceptions inside 192.0.0.0/24", () => {
    expect(isGlobalAddress("192.0.0.9")).toBe(true);
    expect(isGlobalAddress("192.0.0.10")).toBe(true);
    expect(isGlobalAddress("192.0.0.8")).toBe(false);
  });

  it("treats IPv4 multicast as global, matching CPython's verified (if surprising) behavior", () => {
    expect(isGlobalAddress("224.0.0.1")).toBe(true);
    expect(isGlobalAddress("233.4.5.6")).toBe(true);
  });

  it("rejects IPv6 loopback/link-local/unique-local/documentation ranges", () => {
    for (const ip of [
      "::1",
      "::",
      "fe80::1",
      "fc00::1",
      "fd00::1",
      "2001:db8::1",
      "2002::1",
      "2001::1",
      "64:ff9b:1::1",
      "100::1",
    ]) {
      expect(isGlobalAddress(ip)).toBe(false);
    }
  });

  it("accepts real public IPv6 addresses, including the well-known NAT64 prefix", () => {
    for (const ip of ["2001:4860:4860::8888", "2606:4700:4700::1111", "64:ff9b::1"]) {
      expect(isGlobalAddress(ip)).toBe(true);
    }
  });

  it("carves out documented AMT/well-known IPv6 exceptions", () => {
    for (const ip of ["2001:1::1", "2001:1::2", "2001:3::1", "2001:4:112::1", "2001:20::1", "2001:30::1"]) {
      expect(isGlobalAddress(ip)).toBe(true);
    }
  });

  it("treats IPv6 multicast as global, matching CPython's verified (if surprising) behavior", () => {
    expect(isGlobalAddress("ff02::1")).toBe(true);
    expect(isGlobalAddress("ff0e::1")).toBe(true);
  });

  it("defers IPv4-mapped IPv6 addresses to the embedded IPv4 address's own verdict", () => {
    expect(isGlobalAddress("::ffff:127.0.0.1")).toBe(false);
    expect(isGlobalAddress("::ffff:8.8.8.8")).toBe(true);
  });

  it("rejects malformed or non-IP input rather than throwing", () => {
    expect(isGlobalAddress("not-an-ip")).toBe(false);
    expect(isGlobalAddress("")).toBe(false);
    expect(isGlobalAddress("example.com")).toBe(false);
  });
});
