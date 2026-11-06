-- Field Twin Violet v6: ticket attribution. Orders carry the ticket they were ordered for. Arrivals can be linked to
-- the order they filled, carry that ticket, or be marked as sent without an order.
ALTER TABLE public.violet_orders ADD COLUMN IF NOT EXISTS ticket TEXT NOT NULL DEFAULT '';
ALTER TABLE public.violet_events ADD COLUMN IF NOT EXISTS ticket TEXT NOT NULL DEFAULT '';
ALTER TABLE public.violet_events ADD COLUMN IF NOT EXISTS order_id UUID;
ALTER TABLE public.violet_events ADD COLUMN IF NOT EXISTS unordered BOOLEAN NOT NULL DEFAULT false;
