-- Household city for city-specific analysis (network hospitals in city, procedure-cost adequacy).
-- Nullable: analysis answers Unknown until the household supplies it. Rollback: the column is ignored by
-- older code; drop with a table rebuild only if required.
ALTER TABLE households ADD COLUMN city TEXT CHECK (city IS NULL OR (length(city) BETWEEN 1 AND 80));
