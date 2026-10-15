// Field Twin Violet API v2
// BLUE PHONE: builds the Violet tables, row level security, and the photo bucket in the shared Supabase project.
// Runs once at boot when DATABASE_URL is set. Every statement is safe to run again.
import pg from "pg";

const { Pool } = pg;

export const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 2 })
  : null;

export const schemaState = { status: pool ? "pending" : "no DATABASE_URL", failed: [] };

export const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS public.violet_holders (
     id UUID PRIMARY KEY,
     owner UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     kind TEXT NOT NULL DEFAULT 'other',
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS public.violet_catalog (
     id UUID PRIMARY KEY,
     owner UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
     kind TEXT NOT NULL DEFAULT 'part',
     name TEXT NOT NULL DEFAULT '',
     part_number TEXT NOT NULL DEFAULT '',
     manufacturer TEXT NOT NULL DEFAULT '',
     model TEXT NOT NULL DEFAULT '',
     unit TEXT NOT NULL DEFAULT 'each',
     ref_photo TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS public.violet_events (
     id UUID PRIMARY KEY,
     owner UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
     happened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     type TEXT NOT NULL,
     catalog_id UUID NOT NULL REFERENCES public.violet_catalog(id) ON DELETE CASCADE,
     serial TEXT NOT NULL DEFAULT '',
     qty NUMERIC NOT NULL DEFAULT 1,
     condition TEXT NOT NULL DEFAULT 'good',
     from_holder UUID REFERENCES public.violet_holders(id) ON DELETE SET NULL,
     to_holder UUID REFERENCES public.violet_holders(id) ON DELETE SET NULL,
     locker_id TEXT NOT NULL DEFAULT '',
     site TEXT NOT NULL DEFAULT '',
     symptom TEXT NOT NULL DEFAULT '',
     cause TEXT NOT NULL DEFAULT '',
     note TEXT NOT NULL DEFAULT '',
     source TEXT NOT NULL DEFAULT '',
     extracted JSONB,
     photos TEXT[] NOT NULL DEFAULT '{}'
   )`,
  `CREATE INDEX IF NOT EXISTS violet_events_owner_time ON public.violet_events (owner, happened_at)`,
  `CREATE INDEX IF NOT EXISTS violet_events_serial ON public.violet_events (serial) WHERE serial <> ''`,
  ...["violet_holders", "violet_catalog", "violet_events"].flatMap((t) => [
    `ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`,
    `DROP POLICY IF EXISTS "${t} owner" ON public.${t}`,
    `CREATE POLICY "${t} owner" ON public.${t} FOR ALL TO authenticated
       USING (owner = auth.uid()) WITH CHECK (owner = auth.uid())`,
  ]),
  `ALTER TABLE public.violet_catalog ADD COLUMN IF NOT EXISTS vendor TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE public.violet_catalog ADD COLUMN IF NOT EXISTS min_qty NUMERIC NOT NULL DEFAULT 0`,
  `ALTER TABLE public.violet_events ADD COLUMN IF NOT EXISTS vendor TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE public.violet_catalog ADD COLUMN IF NOT EXISTS customer TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE public.violet_events ADD COLUMN IF NOT EXISTS customer TEXT NOT NULL DEFAULT ''`,
  `CREATE TABLE IF NOT EXISTS public.violet_orders (
     id UUID PRIMARY KEY,
     owner UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     ordered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     vendor TEXT NOT NULL DEFAULT '',
     customer TEXT NOT NULL DEFAULT '',
     order_number TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'open',
     lines JSONB NOT NULL DEFAULT '[]'::jsonb,
     note TEXT NOT NULL DEFAULT '',
     source TEXT NOT NULL DEFAULT '',
     photos TEXT[] NOT NULL DEFAULT '{}'
   )`,
  `ALTER TABLE public.violet_orders ENABLE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS "violet_orders owner" ON public.violet_orders`,
  `CREATE POLICY "violet_orders owner" ON public.violet_orders FOR ALL TO authenticated
       USING (owner = auth.uid()) WITH CHECK (owner = auth.uid())`,
  `DO $$ BEGIN
     INSERT INTO storage.buckets (id, name, public) VALUES ('violet-photos', 'violet-photos', false) ON CONFLICT (id) DO NOTHING;
   EXCEPTION WHEN others THEN RAISE NOTICE 'violet photo bucket skipped: %', SQLERRM;
   END $$`,
  `DO $$ BEGIN
     DROP POLICY IF EXISTS "violet photos owner" ON storage.objects;
     CREATE POLICY "violet photos owner" ON storage.objects FOR ALL TO authenticated
       USING (bucket_id = 'violet-photos' AND (storage.foldername(name))[1] = auth.uid()::text)
       WITH CHECK (bucket_id = 'violet-photos' AND (storage.foldername(name))[1] = auth.uid()::text);
   EXCEPTION WHEN others THEN RAISE NOTICE 'violet photo policy skipped: %', SQLERRM;
   END $$`,
];

export async function setupDatabase() {
  if (!pool) return;
  schemaState.failed = [];
  for (const sql of STATEMENTS) {
    try {
      await pool.query(sql);
    } catch (err) {
      const first = sql.trim().split("\n")[0].slice(0, 80);
      schemaState.failed.push(`${first}: ${err.message}`);
      console.error("schema step failed", first, err.message);
    }
  }
  schemaState.status = schemaState.failed.length ? `${schemaState.failed.length} steps failed` : "ready";
}
