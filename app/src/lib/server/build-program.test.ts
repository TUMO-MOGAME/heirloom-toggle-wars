/**
 * Plan §18.3 S5: scripts/build-program.sh, run by bash against stand-ins for anchor, cargo and solana (a throwaway
 * HOME, so no toolchain, wallet or network is ever used here).
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ID = "b3PBVwkLnyx7eyLPNtc5J3Ds3os3cenqCVRHaCJM7FY";
const OTHER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const SCRIPT = path.resolve(process.cwd(), "../scripts/build-program.sh");
// On Windows plain `bash` can be WSL's, which can't see these paths: use Git's.
const BASH = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "/bin/bash";
const unix = (p: string) => (process.platform === "win32" ? `/${p[0].toLowerCase()}${p.slice(2).replaceAll("\\", "/")}` : p);

const STUBS = {
  anchor: `echo "anchor $*" >> "$CALLS"
mkdir -p target/idl target/deploy
printf '{\\n  "address": "%s"\\n}\\n' "$IDL_ID" > target/idl/heirloom.json
head -c "$BYTES" /dev/zero > target/deploy/heirloom.so
echo key > target/deploy/heirloom-keypair.json
`,
  cargo: `echo "cargo $*" >> "$CALLS"
exit "$CARGO_EXIT"
`,
  solana: `echo "solana $*" >> "$CALLS"
case "$1 $2" in
  "genesis-hash "*) echo "$GENESIS" ;;
  "program show") [ "$EXISTS" = 1 ] || exit 1
    echo "{\\"programId\\":\\"p\\",\\"authority\\":\\"$AUTHORITY\\",\\"dataLen\\":$CURRENT,\\"lamports\\":$(( (CURRENT + 45 + 128) * 5080 ))}" ;;
  "address "*) echo me ;;
  "rent "*) echo "{\\"rentExemptMinimumLamports\\":$(( ($2 + 128) * 5080 ))}" ;;
  "balance "*) echo "$BALANCE lamports" ;;
  "program deploy") ;;
  *) exit 9 ;;
esac
`,
};

let roots: string[] = [];
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

function checkout(opts: { libId?: string; tomlId?: string } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "heirloom-build-"));
  roots.push(root);
  const at = (p: string) => path.join(root, p);
  const files: Record<string, string> = {
    "repo/programs/heirloom/src/lib.rs": `declare_id!("${opts.libId ?? ID}");\n`,
    "repo/Anchor.toml": `[programs.localnet]\nheirloom = "${ID}"\n\n[programs.devnet]\nheirloom = "${opts.tomlId ?? ID}"\n`,
    "repo/Cargo.toml": "[workspace]\n",
    "repo/Cargo.lock": "# lock\n",
    "repo/app/src/lib/chain/idl/heirloom.json": "{}\n",
    "home/.config/solana/id.json": "stand-in, not a key\n",
    ...Object.fromEntries(Object.entries(STUBS).map(([name, body]) => [`home/.cargo/bin/${name}`, `#!/usr/bin/env bash\n${body}`])),
  };
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(path.dirname(at(p)), { recursive: true });
    writeFileSync(at(p), body, { mode: 0o755 });
  }
  mkdirSync(at("repo/scripts"));
  cpSync(SCRIPT, at("repo/scripts/build-program.sh"));

  const run = (mode: string | null, env: Record<string, string> = {}) => {
    const r = spawnSync(BASH, [unix(at("repo/scripts/build-program.sh")), ...(mode ? [mode] : [])], {
      encoding: "utf8",
      timeout: 60_000,
      env: {
        NODE_ENV: "test", PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        HOME: unix(at("home")), HEIRLOOM_WORK: unix(at("work")), CALLS: unix(at("calls")),
        GENESIS: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
        IDL_ID: ID, BYTES: "20000", CARGO_EXIT: "0", EXISTS: "1", AUTHORITY: "me", CURRENT: "16000", BALANCE: "900000000",
        ...env,
      },
    });
    return {
      code: r.status,
      output: `${r.stdout}${r.stderr}`,
      calls: existsSync(at("calls")) ? readFileSync(at("calls"), "utf8") : "",
    };
  };
  const read = (p: string) => readFileSync(at(`repo/${p}`), "utf8");
  return { at, run, read, files };
}

const deployed = (calls: string) => calls.includes("solana program deploy");

describe.skipIf(!existsSync(BASH))("scripts/build-program.sh", { timeout: 90_000 }, () => {
  it("test (the default) builds without a keypair, never syncs and changes no source", () => {
    const c = checkout();
    const r = c.run(null);
    expect(r.code, r.output).toBe(0);
    expect(r.calls).toBe("anchor build --ignore-keys\ncargo test -p heirloom\n");
    for (const p of ["programs/heirloom/src/lib.rs", "Anchor.toml", "Cargo.lock", "app/src/lib/chain/idl/heirloom.json"]) {
      expect(c.read(p)).toBe(c.files[`repo/${p}`]);
    }
    expect(readdirSync(c.at("repo/target/deploy"))).toEqual(["heirloom.so"]);
  });

  it("has no key sync, no copy of a source back and no keypair copy in it", () => {
    const code = readFileSync(SCRIPT, "utf8").split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
    expect(code).not.toMatch(/keys sync|keypair\.json|anchor deploy/);
    expect(code).not.toMatch(/cp [^\n]*"\$REPO\/(programs|Anchor\.toml|Cargo)[^\n"]*"\s*$/m);
  });

  it("idl copies the checked IDL into the app", () => {
    const c = checkout();
    expect(c.run("idl").code).toBe(0);
    expect(c.read("app/src/lib/chain/idl/heirloom.json")).toContain(ID);
  });

  it.each([
    ["lib.rs", { libId: OTHER }],
    ["Anchor.toml", { tomlId: OTHER }],
  ])("refuses another id in %s before building", (_where, opts) => {
    const r = checkout(opts).run("deploy");
    expect(r.code).not.toBe(0);
    expect(r.output).toContain("wrong program id");
    expect(r.calls).toBe("");
  });

  it("refuses another id in the built IDL, and copies nothing", () => {
    const c = checkout();
    const r = c.run("idl", { IDL_ID: OTHER });
    expect(r.code).not.toBe(0);
    expect(r.output).toContain("wrong program id");
    expect(c.read("app/src/lib/chain/idl/heirloom.json")).toBe("{}\n");
  });

  it("refuses an unknown mode", () => {
    const r = checkout().run("depoly");
    expect(r.code).not.toBe(0);
    expect(r.calls).toBe("");
  });

  it("refuses a work directory inside the checkout, or one that is something else", () => {
    const inside = checkout();
    expect(inside.run("test", { HEIRLOOM_WORK: unix(inside.at("repo/build")) }).output).toContain("outside the checkout");

    const other = checkout();
    mkdirSync(other.at("work/programs"), { recursive: true });
    writeFileSync(other.at("work/programs/precious"), "keep");
    expect(other.run("test").code).not.toBe(0);
    expect(existsSync(other.at("work/programs/precious"))).toBe(true);
  });

  it("deploy prints size, need and balance, then upgrades by program id", () => {
    const r = checkout().run("deploy");
    expect(r.code, r.output).toBe(0);
    expect(r.output).toMatch(/size:\s+20000 bytes/);
    // buffer (20037 + 128) × 5080, growth of the minimum 10240 × 5080, fees (22 + 10) × 10000
    expect(r.output).toMatch(/needed:\s+0\.154777400 SOL/);
    expect(r.output).toMatch(/balance:\s+0\.900000000 SOL/);
    expect(r.calls).toContain(`solana program deploy target/deploy/heirloom.so --program-id ${ID} --use-rpc --url devnet`);
  });

  it.each([
    ["a short balance", { BALANCE: "154777399" }, "short by"],
    ["another cluster", { GENESIS: "nope" }, "not devnet"],
    ["another upgrade authority", { AUTHORITY: "them" }, "upgrade authority"],
    ["no program to upgrade", { EXISTS: "0" }, "only upgrades"],
    ["a balance it can't read", { BALANCE: "?" }, "could not read"],
    ["failing tests", { CARGO_EXIT: "1" }, ""],
  ])("deploy refuses on %s", (_why, env, says) => {
    const r = checkout().run("deploy", env);
    expect(r.code).not.toBe(0);
    expect(r.output).toContain(says);
    expect(deployed(r.calls)).toBe(false);
  });
});
