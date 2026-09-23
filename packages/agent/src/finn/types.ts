import { z } from "zod"

// Schemas for finn's own payload. These are deliberately strict about the
// fields the valuation depends on (price, year, mileage, make/model) and lax
// about the rest: finn ships frontend changes without notice, and the parser
// should fail loudly when a load-bearing field disappears rather than quietly
// importing listings with a price of undefined.

export const PriceSchema = z.object({
  amount: z.number(),
  currency_code: z.string().optional(),
  price_unit: z.string().optional(),
})

export const CoordinatesSchema = z.object({
  lat: z.number(),
  lon: z.number(),
  accuracy: z.number().optional(),
})

export const SearchEntrySchema = z
  .object({
    ad_id: z.number(),
    heading: z.string(),
    canonical_url: z.string(),
    price: PriceSchema,
    year: z.number().optional(),
    mileage: z.number().optional(),
    mileage_unit: z.string().optional(),
    make: z.string().optional(),
    model: z.string().optional(),
    series: z.string().optional(),
    model_specification: z.string().optional(),
    fuel: z.string().optional(),
    transmission: z.string().optional(),
    /** "Privat" or "Forhandler". */
    dealer_segment: z.string().optional(),
    organisation_name: z.string().optional(),
    org_id: z.string().optional(),
    /** Licence plate — the key into the Vegvesen registry. */
    regno: z.string().optional(),
    /** VIN — stable across relistings, which is what makes relist detection work. */
    chassis_number: z.string().optional(),
    registration_class: z.object({ id: z.number().optional(), value: z.string().optional() }).optional(),
    service_documents: z.array(z.string()).optional(),
    location: z.string().optional(),
    coordinates: CoordinatesSchema.optional(),
    /** Publication time, epoch milliseconds. */
    timestamp: z.number().optional(),
    labels: z.array(z.object({ id: z.string().optional(), text: z.string().optional() })).optional(),
    flags: z.array(z.string()).optional(),
    image_urls: z.array(z.string()).optional(),
    /**
     * Together these say what KIND of ad this is, and their price fields mean
     * different things: ad_type 200 / sales_form 5 is a monthly lease payment,
     * sales_form 7 an auction starting bid. See finn/listing-type.ts.
     */
    sales_form: z.number().optional(),
    ad_type: z.number().optional(),
  })
  // finn adds fields regularly; unknown ones are kept in raw_json, not rejected.
  .loose()

export type SearchEntry = z.infer<typeof SearchEntrySchema>

export const PagingSchema = z.object({
  param: z.string().optional(),
  current: z.number(),
  last: z.number(),
})

export const SearchMetadataSchema = z
  .object({
    search_key: z.string().optional(),
    paging: PagingSchema.optional(),
    result_size: z.object({ match_count: z.number().optional(), group_count: z.number().optional() }).optional(),
    title: z.string().optional(),
    vertical: z.string().optional(),
    is_savable_search: z.boolean().optional(),
  })
  .loose()

export const SearchDataSchema = z
  .object({
    docs: z.array(SearchEntrySchema),
    metadata: SearchMetadataSchema.optional(),
  })
  .loose()

export type SearchData = z.infer<typeof SearchDataSchema>

export interface SearchPage {
  readonly entries: SearchEntry[]
  readonly page: number
  readonly lastPage: number
  readonly matchCount: number
  readonly title?: string
}
