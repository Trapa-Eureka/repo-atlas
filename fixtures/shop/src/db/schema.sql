-- Shop schema
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users (id),
  created_at TIMESTAMP DEFAULT now()
);
