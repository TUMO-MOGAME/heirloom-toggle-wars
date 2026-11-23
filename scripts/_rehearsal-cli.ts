/** rehearse-second-review.ts's two guards, apart from the command so they can be tested: devnet only, dry by default. */
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export interface RehearsalArgs { keypairPath: string; send: boolean; rpc: string }

export function rehearsalArgs(argv: readonly string[]): RehearsalArgs {
  const usage = "usage: rehearse-second-review.ts <funded payer keypair path> [--send] [--rpc <devnet RPC URL>]";
  let keypairPath = "", send = false, rpc = "https://api.devnet.solana.com";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--send") send = true;
    else if (arg === "--rpc" && argv[i + 1] && !argv[i + 1].startsWith("--")) rpc = argv[++i];
    else if (arg.startsWith("--") || keypairPath) throw new Error(usage);
    else keypairPath = arg;
  }
  if (!keypairPath) throw new Error(usage);
  return { keypairPath, send, rpc };
}

/** By the genesis hash, so no RPC URL or environment setting can point this at another cluster. */
export async function assertDevnet(conn: { getGenesisHash(): Promise<string> }): Promise<void> {
  if ((await conn.getGenesisHash()) !== DEVNET_GENESIS) throw new Error("This is not devnet: the rehearsal only runs there. Nothing was sent.");
}
