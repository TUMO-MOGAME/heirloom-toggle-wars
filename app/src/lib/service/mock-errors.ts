/** Program-style errors for the mock service (same error names as the Solana program). Shared by mock*.ts. */
export class ProgramError extends Error {
  code: string;
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.name = "ProgramError";
  }
}

export const fail = (code: string, detail: string): never => { throw new ProgramError(code, detail); };
export const need = (ok: boolean, code: string, detail: string) => { if (!ok) fail(code, detail); };
