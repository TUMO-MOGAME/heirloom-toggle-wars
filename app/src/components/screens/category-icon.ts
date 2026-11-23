import { BookOpen, CircleDot, GraduationCap, House, Stethoscope, type LucideIcon } from "@/components/ui/icons";
import type { Category } from "@/lib/types";

/** The icon for each rule category. Its own module so /will, /claims and /statement don't pull in the whole estate screen. */
export const categoryIcon: Record<Category, LucideIcon> = { Tuition: GraduationCap, Accommodation: House, Books: BookOpen, Medical: Stethoscope, General: CircleDot };
