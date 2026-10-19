CREATE TABLE dish_photos (
  id uuid PRIMARY KEY,
  supplier_id uuid NOT NULL REFERENCES suppliers(id),
  object_key text NOT NULL UNIQUE,
  byte_size integer NOT NULL CHECK (byte_size > 0),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 1600),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 1600),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dish_photos_supplier_idx ON dish_photos(supplier_id,created_at DESC);
