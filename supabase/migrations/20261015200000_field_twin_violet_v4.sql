ALTER TABLE public.violet_catalog ADD COLUMN IF NOT EXISTS customer TEXT NOT NULL DEFAULT '';
ALTER TABLE public.violet_events ADD COLUMN IF NOT EXISTS customer TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS public.violet_orders (
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
);
ALTER TABLE public.violet_orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "violet_orders owner" ON public.violet_orders;
CREATE POLICY "violet_orders owner" ON public.violet_orders FOR ALL TO authenticated
  USING (owner = auth.uid()) WITH CHECK (owner = auth.uid());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.violet_orders TO authenticated;
