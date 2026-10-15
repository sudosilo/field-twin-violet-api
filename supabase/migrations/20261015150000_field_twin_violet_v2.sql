-- Field Twin Violet v2: vendors and reorder levels
ALTER TABLE public.violet_catalog ADD COLUMN IF NOT EXISTS vendor TEXT NOT NULL DEFAULT '';
ALTER TABLE public.violet_catalog ADD COLUMN IF NOT EXISTS min_qty NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE public.violet_events ADD COLUMN IF NOT EXISTS vendor TEXT NOT NULL DEFAULT '';
