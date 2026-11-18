// ISO 3166-1 alpha-2 country codes (spec docs/specs/saved-addresses.md,
// rollout step 1). Saved addresses and create_order's typed address both
// validate `country` against the officially assigned list — until now any
// two letters passed (the spec's Problem section). A dedicated module so
// both surfaces share one list and it stays a leaf (no imports).

/**
 * The 249 officially assigned ISO 3166-1 alpha-2 codes, space-separated in
 * one string (one code per list entry would be 249 lines for no gain).
 * Exceptionally reserved / transitional codes (UK, EU, AC, …) are NOT
 * accepted: EasyPost and postal systems use the official assignments.
 */
const ISO_3166_1_ALPHA_2 =
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ " +
  "BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
  "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ " +
  "DE DJ DK DM DO DZ " +
  "EC EE EG EH ER ES ET " +
  "FI FJ FK FM FO FR " +
  "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY " +
  "HK HM HN HR HT HU " +
  "ID IE IL IM IN IO IQ IR IS IT " +
  "JE JM JO JP " +
  "KE KG KH KI KM KN KP KR KW KY KZ " +
  "LA LB LC LI LK LR LS LT LU LV LY " +
  "MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ " +
  "NA NC NE NF NG NI NL NO NP NR NU NZ " +
  "OM " +
  "PA PE PF PG PH PK PL PM PN PR PS PT PW PY " +
  "QA " +
  "RE RO RS RU RW " +
  "SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ " +
  "TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ " +
  "UA UG UM US UY UZ " +
  "VA VC VE VG VI VN VU " +
  "WF WS " +
  "YE YT " +
  "ZA ZM ZW";

/** Lookup set — use isIsoCountryCode; the Set is exported for tests. */
export const ISO_COUNTRY_CODES: ReadonlySet<string> = new Set(ISO_3166_1_ALPHA_2.split(" "));

/** True when `code` is one of the officially assigned alpha-2 codes
 *  (case-sensitive: uppercase, already trimmed by the caller). */
export function isIsoCountryCode(code: string): boolean {
  return ISO_COUNTRY_CODES.has(code);
}

/** Uppercase-trim a user-supplied code and check it against the list —
 *  the single normalize-then-validate entry point both surfaces use. */
export function normalizeCountryCode(code: string): string {
  const normalized = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized) || !isIsoCountryCode(normalized)) {
    throw new CountryCodeError(normalized);
  }
  return normalized;
}

/** `country` is not an ISO 3166-1 alpha-2 code. The message names the
 *  field and the constraint, never the submitted value (no-payload rule). */
export class CountryCodeError extends Error {
  readonly code = "invalid_country";
  constructor(submitted: string) {
    super(
      `country must be an ISO 3166-1 alpha-2 code (2 letters, e.g. IT) — got ${submitted.length} characters`,
    );
    this.name = "CountryCodeError";
  }
}
