/**
 * Report categories — fixed contract shared with the mobile app and the DB.
 *
 * `visual` is written for an image classifier: what the problem typically
 * LOOKS LIKE in a phone photo, plus the most common confusions to avoid.
 * `photographable: false` marks categories that rarely show up clearly in a
 * photo (noise, ASB, missed bins) — the model should lean on the user's
 * context hint for those and keep confidence modest from pixels alone.
 */

export const CATEGORY_SLUGS = [
  "pothole",
  "damaged_pavement",
  "road_markings_signs",
  "street_light",
  "overgrown_vegetation",
  "missed_bin",
  "fly_tipping",
  "overflowing_litter_bin",
  "dog_fouling",
  "drug_litter",
  "graffiti",
  "abandoned_vehicle",
  "noise",
  "asb",
  "other",
] as const;

export type CategorySlug = typeof CATEGORY_SLUGS[number];

export interface CategoryInfo {
  slug: CategorySlug;
  label: string;
  visual: string;
  photographable: boolean;
}

export const CATEGORIES: readonly CategoryInfo[] = [
  {
    slug: "pothole",
    label: "Pothole",
    visual:
      "Hole, crater or broken-up patch in a road or car-park surface (tarmac/asphalt), often with loose stones or water pooled inside. On a carriageway, not a footway.",
    photographable: true,
  },
  {
    slug: "damaged_pavement",
    label: "Damaged pavement",
    visual:
      "Footway/pavement defects: cracked, sunken, raised or missing paving slabs, trip hazards, broken kerbs, lifted tarmac on a footpath. Pedestrian surface rather than the road.",
    photographable: true,
  },
  {
    slug: "road_markings_signs",
    label: "Road markings or signs",
    visual:
      "Faded or missing white/yellow road lines, worn zebra crossings, damaged, bent, knocked-down, obscured or missing road signs and bollards.",
    photographable: true,
  },
  {
    slug: "street_light",
    label: "Broken street light",
    visual:
      "Street lamp column that is unlit at night, flickering, lit in daytime, leaning, knocked down, with a missing or smashed lantern, or exposed wiring/open access door.",
    photographable: true,
  },
  {
    slug: "overgrown_vegetation",
    label: "Overgrown vegetation",
    visual:
      "Hedges, trees, brambles or weeds overhanging or blocking a pavement, road, sign or street light; fallen branches; heavy weed growth across a footway.",
    photographable: true,
  },
  {
    slug: "missed_bin",
    label: "Missed bin collection",
    visual:
      "Household wheelie bins, recycling boxes or sacks left out at the kerbside, usually full, on collection day. Hard to tell from a photo alone — rely on context (e.g. 'bin not collected').",
    photographable: false,
  },
  {
    slug: "fly_tipping",
    label: "Fly-tipping",
    visual:
      "Illegally dumped waste on public land, verges, alleys or lay-bys: bin bags, mattresses, furniture, fridges, tyres, builders' rubble, piles of rubbish not in a bin.",
    photographable: true,
  },
  {
    slug: "overflowing_litter_bin",
    label: "Overflowing litter bin",
    visual:
      "Public street litter bin (on a post or free-standing, not a household wheelie bin) that is full, overflowing, with rubbish piled around it, or the bin itself damaged.",
    photographable: true,
  },
  {
    slug: "dog_fouling",
    label: "Dog fouling",
    visual:
      "Dog mess on a pavement, path, verge or park grass; or tied dog-waste bags left on the ground or hung on trees/fences.",
    photographable: true,
  },
  {
    slug: "drug_litter",
    label: "Drug litter",
    visual:
      "Discarded hypodermic needles/syringes, sharps, small silver nitrous-oxide canisters, foil, small drug bags or other drug paraphernalia on the ground.",
    photographable: true,
  },
  {
    slug: "graffiti",
    label: "Graffiti",
    visual:
      "Spray paint, tags, marker pen or scratched lettering on walls, bus shelters, signs, bridges or street furniture; also flyposting (unauthorised posters/stickers).",
    photographable: true,
  },
  {
    slug: "abandoned_vehicle",
    label: "Abandoned vehicle",
    visual:
      "Car, van, motorbike or caravan that looks left for a long time: flat tyres, broken windows, missing plates, damage, dirt/leaves built up, untaxed. A normally parked car is NOT abandoned.",
    photographable: true,
  },
  {
    slug: "noise",
    label: "Noise",
    visual:
      "Rarely visible. Maybe speakers, a party, building works or an alarm. Use the context hint; without it, keep confidence low.",
    photographable: false,
  },
  {
    slug: "asb",
    label: "Anti-social behaviour",
    visual:
      "Rarely visible directly. Could show vandalism aftermath, damaged property, or gatherings. Use the context hint; without it, keep confidence low. Never identify the people involved.",
    photographable: false,
  },
  {
    slug: "other",
    label: "Other",
    visual:
      "A genuine public-realm problem that fits none of the above (e.g. blocked drain, damaged bench, broken playground equipment).",
    photographable: true,
  },
];

const SLUG_SET: ReadonlySet<string> = new Set(CATEGORY_SLUGS);

export function isCategorySlug(value: unknown): value is CategorySlug {
  return typeof value === "string" && SLUG_SET.has(value);
}

/** Category list rendered for the system prompt. */
export function renderCategoryGuide(): string {
  return CATEGORIES.map((c) =>
    `- ${c.slug}${c.photographable ? "" : " [rarely photographable — lean on context]"}: ${c.visual}`
  ).join("\n");
}
