// B3-5 curated official-source catalogue. Entries are added by hand, one verified record at a time, in the shape
// `validateOfficialSource` checks. It is empty on purpose: no regulator or insurer record has been verified against
// its official publication yet, and an unverified entry would look like an authority. No crawler, no network call.
import { deepFreeze } from './contracts.js';

export const CURATED_OFFICIAL_SOURCES = deepFreeze([]);

// Curated insurer products (see curated-products.js). Empty on purpose: nothing may be added until a person has read
// the insurer's own published wording and a second person has checked it. Never add a record from a model, an
// aggregator or memory.
export const CURATED_PRODUCT_RECORDS = deepFreeze([]);
