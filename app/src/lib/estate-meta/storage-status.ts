/** Whether the server keeps names across restarts (GET /api/estate-meta with no estate), for the notice in the UI. */

let asked: Promise<boolean | null> | null = null;

/** null when it couldn't be asked: the notice then stays away rather than guess. */
export function namesAreDurable(get: typeof fetch = (...a) => fetch(...a)): Promise<boolean | null> {
  asked ??= get("/api/estate-meta", { cache: "no-store" })
    .then(async (res) => {
      const body = res.ok ? ((await res.json()) as { durable?: unknown }) : null;
      return typeof body?.durable === "boolean" ? body.durable : null;
    })
    .catch(() => null)
    .then((durable) => {
      if (durable === null) asked = null; // ask again next time
      return durable;
    });
  return asked;
}
