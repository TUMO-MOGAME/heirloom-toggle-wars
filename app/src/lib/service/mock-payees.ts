/** The demo's approved payees. Their own small file: the plan builder reads the names without loading the demo service. */
import type { PayeeKind } from "../types";

export const DEMO_PAYEES: readonly { wallet: string; kind: PayeeKind; name: string }[] = [
  { wallet: "UCT1uNiVeRsItYoFcApEtOwN5sZc3FdYg8uE6rAoPaY1", kind: "University", name: "University of Cape Town" },
  { wallet: "WiTs2uNiVeRsItYwItWaTeRsRaNd3FdYg8uE6rAoPaY2", kind: "University", name: "University of the Witwatersrand" },
  { wallet: "MoRr3iSiSaAcSoNhIgHsChOoLsOwEtOg8uE6rAoPaY3", kind: "School", name: "Morris Isaacson High School" },
  { wallet: "SoUt4hPoInTsTuDeNtReSiDeNcEsBrAaMg8uE6rAPaY4", kind: "Landlord", name: "South Point Student Residences" },
  { wallet: "VaNs5cHaIkBoOkStOrEbRaAmFoNtEiNg8uE6rAoPaY55", kind: "Other", name: "Van Schaik Bookstore" },
];
