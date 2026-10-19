CREATE TABLE suppliers (
  id uuid PRIMARY KEY,
  login text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE supplier_sessions (
  token_hash text PRIMARY KEY,
  supplier_id uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX supplier_sessions_expiry_idx ON supplier_sessions(expires_at);

CREATE TABLE guest_sessions (
  token_hash text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE batches (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  order_date date NOT NULL,
  min_participants integer NOT NULL DEFAULT 10 CHECK (min_participants BETWEEN 1 AND 100),
  min_paid_portions integer NOT NULL DEFAULT 10 CHECK (min_paid_portions BETWEEN 1 AND 100),
  office text NOT NULL,
  delivery_at timestamptz NOT NULL,
  order_deadline timestamptz NOT NULL,
  payment_deadline timestamptz NOT NULL,
  payment_instructions text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'cancelled')),
  payment_opened boolean NOT NULL DEFAULT false,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (payment_deadline >= order_deadline)
);
CREATE INDEX batches_latest_idx ON batches(created_at DESC);

CREATE TABLE meals (
  batch_id uuid NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  id text NOT NULL,
  name text NOT NULL,
  description text NOT NULL,
  tag text NOT NULL DEFAULT '',
  image text NOT NULL DEFAULT '',
  details text NOT NULL DEFAULT '',
  price integer NOT NULL CHECK (price BETWEEN 1 AND 1000000),
  position integer NOT NULL DEFAULT 0,
  PRIMARY KEY(batch_id, id)
);

CREATE TABLE orders (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  guest_hash text NOT NULL REFERENCES guest_sessions(token_hash),
  name text NOT NULL,
  department text NOT NULL DEFAULT '',
  payment text NOT NULL DEFAULT 'unpaid' CHECK (payment IN ('unpaid', 'pending', 'paid', 'refund_due', 'refunded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(batch_id, guest_hash),
  UNIQUE(id, batch_id)
);

CREATE TABLE order_items (
  order_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  meal_id text NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  unit_price integer NOT NULL CHECK (unit_price BETWEEN 1 AND 1000000),
  PRIMARY KEY(order_id, meal_id),
  FOREIGN KEY(order_id, batch_id) REFERENCES orders(id, batch_id) ON DELETE CASCADE,
  FOREIGN KEY(batch_id, meal_id) REFERENCES meals(batch_id, id)
);
