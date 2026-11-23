import type { Role } from "../types";

/**
 * A wallet that is in Heirloom as family, a trusted person or a buyer can start its own plan from a page only the
 * owner opens (/will): generation 2 becomes the owner of generation 3's estate with the same wallet. On chain only:
 * the demo personas keep their fixed roles.
 */
export function canStartOwnPlan(pageRoles: readonly Role[] | undefined, role: Role, isMock: boolean): boolean {
  return !isMock && !!pageRoles?.includes("owner") && role !== "owner";
}
