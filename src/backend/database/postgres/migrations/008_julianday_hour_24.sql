-- julianday(text) parity with SQLite 3.54 (Node 26.12 and later). SQLite 3.54 accepts hour 24 only
-- as exactly 24:00:00 (any fraction zero); 24:01, 24:00:01 and 24:00:00.5 now return NULL. Older
-- SQLite accepted them. Same body as 001 with that one check added; 003's search_path is restated
-- because CREATE OR REPLACE resets function settings. No table or CHECK changes.
CREATE OR REPLACE FUNCTION public.julianday(input text) RETURNS double precision
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
SET search_path TO pg_catalog, public, pg_temp
AS $$
DECLARE
  parts text[];
  neg boolean := false;
  y bigint := 2000;
  mo bigint := 1;
  d bigint := 1;
  h bigint := 0;
  mi bigint := 0;
  secs double precision := 0;
  frac double precision := 0;
  scale double precision := 1;
  tz bigint := 0;
  has_time boolean := false;
  ijd bigint;
  a bigint;
  b bigint;
  x1 bigint;
  x2 bigint;
  r double precision;
  digits text;
  i integer;
BEGIN
  -- Date, optionally followed by a time. Groups: 1 sign, 2 Y, 3 M, 4 D, 5 h, 6 m, 7 s, 8 fraction,
  -- 9 'Z', 10 zone sign, 11 zone hours, 12 zone minutes.
  parts := regexp_match(input,
    '^(-?)([0-9]{4})-([0-9]{2})-([0-9]{2})[ \t\n\v\f\rT]*(?:([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]+))?)?[ \t\n\v\f\r]*(?:([Zz])|([+-])([0-9]{2}):([0-9]{2}))?[ \t\n\v\f\r]*)?$');
  IF parts IS NOT NULL THEN
    neg := parts[1] = '-';
    y := parts[2]::bigint;
    mo := parts[3]::bigint;
    d := parts[4]::bigint;
    IF y > 14712 OR mo < 1 OR mo > 12 OR d < 1 OR d > 31 THEN RETURN NULL; END IF;
    IF neg THEN y := -y; END IF;
  ELSE
    -- A bare time uses 2000-01-01 as its date. Groups: 1 h, 2 m, 3 s, 4 fraction, 5 'Z',
    -- 6 zone sign, 7 zone hours, 8 zone minutes.
    parts := regexp_match(input,
      '^([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]+))?)?[ \t\n\v\f\r]*(?:([Zz])|([+-])([0-9]{2}):([0-9]{2}))?[ \t\n\v\f\r]*$');
    IF parts IS NOT NULL THEN
      parts := ARRAY[NULL, NULL, NULL, NULL] || parts;
    ELSIF input ~ '^[ \t\n\v\f\r]*[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?[ \t\n\v\f\r]*$' THEN
      r := btrim(input, E' \t\n\v\f\r')::double precision;
      IF r >= 0.0 AND r < 5373484.5 THEN
        ijd := trunc(r * 86400000.0 + 0.5)::bigint;
        RETURN ijd::double precision / 86400000.0;
      END IF;
      RETURN NULL;
    ELSE
      RETURN NULL;
    END IF;
  END IF;

  -- parts[5..12] now hold the time and zone groups in both branches.
  IF parts[5] IS NOT NULL THEN
    has_time := true;
    h := parts[5]::bigint;
    mi := parts[6]::bigint;
    IF h > 24 OR mi > 59 THEN RETURN NULL; END IF;
    IF parts[7] IS NOT NULL THEN
      secs := parts[7]::bigint;
      IF secs > 59 THEN RETURN NULL; END IF;
    END IF;
    IF parts[8] IS NOT NULL THEN
      digits := parts[8];
      FOR i IN 1..length(digits) LOOP
        frac := frac * 10.0 + substr(digits, i, 1)::integer;
        scale := scale * 10.0;
      END LOOP;
      frac := frac / scale;
      IF frac > 0.999 THEN frac := 0.999; END IF;
      secs := secs + frac;
    END IF;
    IF h = 24 AND (mi > 0 OR secs > 0) THEN RETURN NULL; END IF;
    IF parts[10] IS NOT NULL THEN
      IF parts[11]::bigint > 14 OR parts[12]::bigint > 59 THEN RETURN NULL; END IF;
      tz := (CASE parts[10] WHEN '-' THEN -1 ELSE 1 END) * (parts[12]::bigint + parts[11]::bigint * 60);
    END IF;
  END IF;

  a := y;
  IF mo <= 2 THEN
    a := y - 1;
    x2 := mo + 12;
  ELSE
    x2 := mo;
  END IF;
  b := a / 100;
  b := 2 - b + (b / 4);
  x1 := 36525 * (a + 4716) / 100;
  x2 := 306001 * (x2 + 1) / 10000;
  ijd := trunc((x1 + x2 + d + b - 1524.5) * 86400000.0)::bigint;
  IF has_time THEN
    ijd := ijd + h * 3600000 + mi * 60000 + trunc(secs * 1000.0 + 0.5)::bigint;
    ijd := ijd - tz * 60000;
  END IF;
  IF ijd < 0 OR ijd > 464269060799999 THEN RETURN NULL; END IF;
  RETURN ijd::double precision / 86400000.0;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;
