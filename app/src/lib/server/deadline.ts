/** A promise that gives up after `ms`. The work itself can't be cancelled: the caller treats it as "unknown". */
export class DeadlineError extends Error {
  constructor(what: string) {
    super(`${what}: no answer in time.`);
    this.name = "DeadlineError";
  }
}

export async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DeadlineError(what)), Math.max(0, ms)); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
