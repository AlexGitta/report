-- Several contact rows can match the same authority + category (e.g. a generic GOV.UK
-- Local Links page and a hand-verified deep link to the council's actual form).
-- Routing picks the highest priority among equally specific matches.
alter table public.authority_contacts
  add column priority smallint not null default 0;

comment on column public.authority_contacts.priority is
  'Higher wins among equally specific matches. GOV.UK Local Links = 0; hand-verified form links = 100.';
