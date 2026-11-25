-- Canonical synthetic-seller predicate — WHERE fragment, sellers aliased `s`.
--
-- Single source of truth for organic-vs-synthetic seller classification
-- (docs/ops-smoke-policy.md "Audit" + the THI-1501 canonical counting rule).
-- Consumed by scripts/daily-metrics.sh (organic-only demand metrics + the
-- daily `synthetic` strip) and scripts/check-fixture-leaks.sh (identity-level
-- leak sweep). Both load this file and splice it into their queries.
--
-- Classification is email-based: the disposable `ops+...@thingery.test` tag is
-- the identity anchor mandated by ops-smoke-policy rule 1 (titles are mutable
-- and never used). The remaining domains are test/demo/e2e mail domains
-- observed accumulating synthetic sellers in real deployments. Sellers with a
-- NULL email are legacy API-key-era accounts and count as organic.
--
-- Usage contracts:
--   synthetic = ( <this fragment> )
--   organic   = ( NOT ( <this fragment> ) OR s.email IS NULL )
-- Keep this file format strict: full-line `--` comments only, predicate
-- lines start at column 0 — consumers strip comment lines and join the rest.

s.email LIKE 'ops+%'
OR s.email LIKE '%@thingery.test'
OR s.email LIKE '%@test.thingery.dev'
OR s.email LIKE '%@demo.thingery.dev'
OR s.email LIKE '%@example.com'
OR s.email LIKE '%@example.test'
OR s.email LIKE '%@e2e-test.invalid'
OR s.email LIKE '%mail-tester.com'
