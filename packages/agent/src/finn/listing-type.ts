// finn's car search returns three different kinds of thing under one roof, and
// their `price` fields do not mean the same thing:
//
//   sale     ad_type 20, sales_form 1  — the asking price
//   auction  ad_type 20, sales_form 7  — a starting bid
//   lease    ad_type 200, sales_form 5 — a MONTHLY payment
//
// Mixing them is not a rounding error. 65 lease ads averaging 5 992 kr were
// sitting in a corpus where real cars average 185 455 kr, and three of the four
// Porsche Macans on file were leases — so every Macan valuation was drawn from
// a sample that was three-quarters monthly payments.
//
// This is also why relist detection was firing falsely: the same VIN often
// appears twice, once for sale and once to lease, which is one car advertised
// two ways rather than a car that failed to sell.

export type ListingType = "sale" | "lease" | "auction" | "other"

export function classifyListing(entry: { ad_type?: unknown; sales_form?: unknown }): ListingType {
  const adType = Number(entry.ad_type)
  const salesForm = Number(entry.sales_form)

  // Leasing is the one that must never be wrong, so it is matched on either
  // signal rather than requiring both — a monthly payment read as a purchase
  // price is the most damaging mistake available here.
  if (adType === 200 || salesForm === 5) return "lease"
  if (salesForm === 7) return "auction"
  if (adType === 20 && salesForm === 1) return "sale"
  return "other"
}

/** Whether this listing's price is evidence of what the market pays. */
export function isMarketEvidence(type: ListingType): boolean {
  // Only a real asking price. A starting bid understates what the car will go
  // for, and a monthly lease payment is not a price at all.
  return type === "sale"
}

/** Whether it belongs in the deals feed. */
export function isBuyable(type: ListingType): boolean {
  // Auctions stay: they are a genuine way to buy a car, and are flagged rather
  // than hidden. Leases are not a purchase and have no place in a buying feed.
  return type === "sale" || type === "auction"
}

export const LISTING_TYPE_LABEL: Record<ListingType, string> = {
  sale: "Til salgs",
  lease: "Leasing",
  auction: "Auksjon",
  other: "Ukjent annonsetype",
}
