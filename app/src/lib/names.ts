/**
 * Demo people have one full name (persona lists, the People and Estate screens) and one short form for sentences,
 * so a person reads the same on every screen:
 * - a professional title keeps the surname: "Adv. Thandi Ndlovu" → "Adv. Ndlovu", "Ms. Anita Pillay" → "Ms. Pillay";
 * - a family title keeps the first name: "Uncle Bongani Mokoena" → "Uncle Bongani", "Aunt Zodwa Mokoena" → "Aunt Zodwa";
 * - anyone else goes by their first name: "Lerato Mokoena" → "Lerato".
 * A role in brackets ("Adv. Thandi Ndlovu (executor)") is dropped first.
 */
const PROFESSIONAL = /^(Adv\.?|Ms\.?|Mr\.?|Mrs\.?|Dr\.?|Prof\.?|Pastor|Rev\.?)$/i;
const FAMILY = /^(Uncle|Aunt|Auntie|Gogo|Mkhulu|Cousin)$/i;

/** The name without a trailing "(role)". */
export function fullName(name: string): string {
  return name.replace(/\s*\(.*\)$/, "").trim();
}

/** The short form used in sentences (see above). */
export function shortName(name: string): string {
  const parts = fullName(name).split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? "";
  if (PROFESSIONAL.test(parts[0])) return `${parts[0]} ${parts[parts.length - 1]}`;
  if (FAMILY.test(parts[0])) return `${parts[0]} ${parts[1]}`;
  return parts[0];
}
