import { describe, expect, it } from "vitest";

import {
  choosePython,
  isLocalHost,
  parseListeningPids,
  pickExisting,
  serverHostAndPort,
} from "../electron/server-control";

describe("serverHostAndPort", () => {
  it("reads an explicit port", () => {
    expect(serverHostAndPort("http://203.0.113.19:8765")).toEqual({
      host: "203.0.113.19",
      port: 8765,
    });
  });

  it("defaults the port from the protocol", () => {
    expect(serverHostAndPort("http://example.test")).toEqual({ host: "example.test", port: 80 });
    expect(serverHostAndPort("https://example.test")).toEqual({ host: "example.test", port: 443 });
  });

  it("strips brackets from an IPv6 host", () => {
    expect(serverHostAndPort("http://[::1]:8765")).toEqual({ host: "::1", port: 8765 });
  });
});

describe("isLocalHost", () => {
  const addresses = ["127.0.0.1", "::1", "203.0.113.19", "fe80::abcd"];

  it.each(["localhost", "LOCALHOST", "127.0.0.1", "::1"])(
    "always treats %s as this machine",
    (host) => {
      expect(isLocalHost(host, [])).toBe(true);
    },
  );

  it("matches an interface address case-insensitively", () => {
    expect(isLocalHost("203.0.113.19", addresses)).toBe(true);
    expect(isLocalHost("FE80::ABCD", addresses)).toBe(true);
  });

  it("rejects other machines and empty hosts", () => {
    expect(isLocalHost("203.0.113.11", addresses)).toBe(false);
    expect(isLocalHost("", addresses)).toBe(false);
  });
});

describe("parseListeningPids", () => {
  const netstat = [
    "Active Connections",
    "",
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    0.0.0.0:8765           0.0.0.0:0              LISTENING       4321",
    "  TCP    [::]:8765              [::]:0                 LISTENING       4321",
    "  TCP    0.0.0.0:18765          0.0.0.0:0              LISTENING       9999",
    "  TCP    203.0.113.19:8765      203.0.113.11:52001     ESTABLISHED     4321",
    "  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4",
    "  UDP    0.0.0.0:5353           *:*                                    2222",
  ].join("\r\n");

  it("finds only listeners on the exact port, deduplicated", () => {
    expect(parseListeningPids(netstat, 8765)).toEqual([4321]);
  });

  it("does not confuse a longer port that ends with the same digits", () => {
    expect(parseListeningPids(netstat, 18765)).toEqual([9999]);
  });

  it("never returns the System pseudo-process", () => {
    expect(parseListeningPids(netstat, 445)).toEqual([]);
  });

  it("returns nothing when the port is free", () => {
    expect(parseListeningPids(netstat, 8766)).toEqual([]);
  });
});

describe("pickExisting", () => {
  it("returns the first candidate that exists, skipping blanks", () => {
    const exists = (candidate: string) => candidate.endsWith("server.py");
    expect(pickExisting(["", "C:\\missing.txt", "C:\\repo\\server.py"], exists)).toBe(
      "C:\\repo\\server.py",
    );
  });

  it("returns null when nothing exists", () => {
    expect(pickExisting(["C:\\missing.txt"], () => false)).toBeNull();
  });
});

describe("choosePython", () => {
  const localAppData = "C:\\Users\\someone\\AppData\\Local";

  it("prefers a configured interpreter that exists", () => {
    const configured = "D:\\tools\\python\\python.exe";
    expect(choosePython(configured, localAppData, () => [], (p) => p === configured)).toEqual({
      command: configured,
      args: [],
    });
  });

  it("returns null for a configured interpreter that is missing", () => {
    expect(choosePython("D:\\gone\\python.exe", localAppData, () => [], () => false)).toBeNull();
  });

  it("scans the per-user install and picks the newest version numerically", () => {
    // Numeric ordering matters: 3.13 is newer than 3.9 despite sorting lower as text.
    const listDir = () => ["Python39", "Python313", "Launcher", "notes.txt"];
    const chosen = choosePython(undefined, localAppData, listDir, (candidate) =>
      candidate.endsWith("python.exe"),
    );
    expect(chosen?.command).toBe(
      "C:\\Users\\someone\\AppData\\Local\\Programs\\Python\\Python313\\python.exe",
    );
  });

  it("falls back to the py launcher, never bare python", () => {
    expect(choosePython(undefined, localAppData, () => [], () => false)).toEqual({
      command: "py",
      args: ["-3"],
    });
    expect(choosePython(undefined, undefined, () => [], () => false)).toEqual({
      command: "py",
      args: ["-3"],
    });
  });
});
