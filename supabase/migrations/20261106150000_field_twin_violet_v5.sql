-- Field Twin Violet v5: company parts. An item marked company belongs to the company (issued from the warehouse),
-- not to you. Working and not working counts come from the condition on each logged event, including the new
-- Tested event type written by Count stuff, so no other table changes are needed.
ALTER TABLE public.violet_catalog ADD COLUMN IF NOT EXISTS company BOOLEAN NOT NULL DEFAULT false;
