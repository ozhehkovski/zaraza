CREATE TABLE IF NOT EXISTS users(id SERIAL PRIMARY KEY,telegram_id BIGINT NOT NULL UNIQUE,language TEXT NOT NULL DEFAULT 'pl',created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS products(id SERIAL PRIMARY KEY,store TEXT NOT NULL,external_id TEXT NOT NULL,url TEXT NOT NULL,name TEXT NOT NULL,image_url TEXT,currency TEXT NOT NULL,next_check_at TIMESTAMPTZ NOT NULL DEFAULT now(),failures INTEGER NOT NULL DEFAULT 0,last_error TEXT,created_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now(),UNIQUE(store,external_id));
CREATE TABLE IF NOT EXISTS variants(id SERIAL PRIMARY KEY,product_id INTEGER NOT NULL REFERENCES products(id),external_variant_id TEXT NOT NULL,size TEXT NOT NULL,UNIQUE(product_id,external_variant_id));
CREATE TABLE IF NOT EXISTS watches(id SERIAL PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),product_id INTEGER NOT NULL REFERENCES products(id),variant_id INTEGER NOT NULL REFERENCES variants(id),watch_price BOOLEAN NOT NULL,watch_stock BOOLEAN NOT NULL,target_price INTEGER,enabled BOOLEAN NOT NULL DEFAULT true,created_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now(),UNIQUE(user_id,variant_id));
CREATE TABLE IF NOT EXISTS product_state(variant_id INTEGER PRIMARY KEY REFERENCES variants(id),product_id INTEGER NOT NULL REFERENCES products(id),price INTEGER NOT NULL,original_price INTEGER,available BOOLEAN NOT NULL,checked_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS price_history(id SERIAL PRIMARY KEY,product_id INTEGER NOT NULL REFERENCES products(id),variant_id INTEGER NOT NULL REFERENCES variants(id),price INTEGER NOT NULL,available BOOLEAN NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS drafts(user_id INTEGER PRIMARY KEY REFERENCES users(id),product_id INTEGER NOT NULL REFERENCES products(id),variant_id INTEGER REFERENCES variants(id),stage TEXT NOT NULL,expires_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS notification_outbox(id SERIAL PRIMARY KEY,watch_id INTEGER NOT NULL REFERENCES watches(id),payload JSONB NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),sent_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS due_products ON products(next_check_at);
CREATE INDEX IF NOT EXISTS enabled_product_watches ON watches(product_id,enabled);
CREATE INDEX IF NOT EXISTS history_variant ON price_history(variant_id,created_at);
CREATE INDEX IF NOT EXISTS pending_notifications ON notification_outbox(sent_at,next_attempt_at);
ALTER TABLE variants ADD COLUMN IF NOT EXISTS selectable BOOLEAN NOT NULL DEFAULT true;
-- variant_id NULL = watch on every size of the product.
ALTER TABLE watches ALTER COLUMN variant_id DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS watch_all_sizes ON watches(user_id,product_id) WHERE variant_id IS NULL;
