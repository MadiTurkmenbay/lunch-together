CREATE TABLE dish_catalog (
  id uuid PRIMARY KEY,
  supplier_id uuid NOT NULL REFERENCES suppliers(id),
  name text NOT NULL,
  description text NOT NULL,
  tag text NOT NULL DEFAULT '',
  image text NOT NULL,
  details text NOT NULL DEFAULT '',
  price integer NOT NULL CHECK (price BETWEEN 1 AND 1000000),
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dish_catalog_supplier_idx ON dish_catalog(supplier_id, archived);

-- Existing batch menus remain immutable; copy their latest dish versions into the pool.
INSERT INTO dish_catalog(id,supplier_id,name,description,tag,image,details,price)
SELECT gen_random_uuid(),s.id,m.name,m.description,m.tag,m.image,m.details,m.price
FROM suppliers s CROSS JOIN (
  SELECT DISTINCT ON (lower(trim(m.name))) m.* FROM meals m JOIN batches b ON b.id=m.batch_id
  ORDER BY lower(trim(m.name)),b.created_at DESC,b.id DESC,m.position
) m;

CREATE TABLE menu_plans (
  id uuid PRIMARY KEY,
  supplier_id uuid NOT NULL REFERENCES suppliers(id),
  title text NOT NULL,
  office text NOT NULL,
  delivery_at timestamptz NOT NULL,
  order_deadline timestamptz NOT NULL,
  payment_deadline timestamptz NOT NULL,
  min_participants integer NOT NULL CHECK (min_participants BETWEEN 1 AND 100),
  min_paid_portions integer NOT NULL CHECK (min_paid_portions BETWEEN 1 AND 100),
  payment_instructions text NOT NULL DEFAULT '',
  published_batch_id uuid UNIQUE REFERENCES batches(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (order_deadline <= payment_deadline AND payment_deadline < delivery_at)
);
CREATE INDEX menu_plans_supplier_idx ON menu_plans(supplier_id, delivery_at DESC);

CREATE TABLE menu_plan_items (
  plan_id uuid NOT NULL REFERENCES menu_plans(id) ON DELETE CASCADE,
  dish_id uuid NOT NULL REFERENCES dish_catalog(id),
  position integer NOT NULL,
  name text NOT NULL,
  description text NOT NULL,
  tag text NOT NULL DEFAULT '',
  image text NOT NULL,
  details text NOT NULL DEFAULT '',
  price integer NOT NULL CHECK (price BETWEEN 1 AND 1000000),
  PRIMARY KEY(plan_id, dish_id)
);
