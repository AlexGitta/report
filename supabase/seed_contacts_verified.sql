-- Hand-verified deep links to councils' actual reporting forms (not info pages).
-- priority 100 beats the generic GOV.UK Local Links rows (priority 0) in routing.
-- Verify each URL returns the named form before adding it; record the date in notes.
--
-- Manchester City Council (E08000003): Verint portal. Verified 2026-09-26 by fetching
-- each URL and checking the form title. Missed bins require a portal sign-in.

delete from public.authority_contacts where notes like 'Verified:%' and authority_gss = 'E08000003';

insert into public.authority_contacts (authority_gss, category_id, category_group, form_url, priority, notes)
select 'E08000003', c.id, c.category_group, v.url, 100, 'Verified: 2026-09-26 · ' || v.title
from (values
  ('pothole',                'https://manchester.portal.uk.empro.verintcloudservices.com/site/myaccount/request/report_pothole_road_pavement_damage', 'Potholes'),
  ('damaged_pavement',       'https://manchester.portal.uk.empro.verintcloudservices.com/site/myaccount/request/report_pothole_road_pavement_damage', 'Potholes (road or pavement damage)'),
  ('road_markings_signs',    'https://manchester.portal.uk.empro.verintcloudservices.com/site/myaccount/request/faulty_streetlight_bollard',          'Faulty street light, bollard or road sign'),
  ('street_light',           'https://manchester.portal.uk.empro.verintcloudservices.com/site/myaccount/request/faulty_streetlight_bollard',          'Faulty street light, bollard or road sign'),
  ('overgrown_vegetation',   'https://manchester.portal.uk.empro.verintcloudservices.com/site/myaccount/request/obstruction_on_the_road_pavement_public_right_of_way', 'Obstructions on the road, pavement or public right of way (no dedicated vegetation form)'),
  ('missed_bin',             'https://manchester.portal.uk.empro.verintcloudservices.com/site/myaccount/request/bin_box_or_bag_wasnt_collected',     'Bin, box or bag not collected (sign-in required)'),
  ('fly_tipping',            'https://manchester.portal.uk.empro.verintcloudservices.com/site/myaccount/request/sr_fly_tipping',                     'Dumped rubbish'),
  ('overflowing_litter_bin', 'https://manchester.portal.uk.empro.verintcloudservices.com/site/myaccount/request/sr_litter_dog_bin',                  'Litter bin problems'),
  ('dog_fouling',            'https://manchester.portal.uk.empro.verintcloudservices.com/site/myaccount/request/dog_poo',                            'Dog poo'),
  ('drug_litter',            'https://www.manchester.gov.uk/info/100006/environmental_problems/6167/remove_a_needle_or_syringe',                    'Remove a needle or syringe (info page; no dedicated portal form)'),
  ('graffiti',               'https://manchester.portal.uk.empro.verintcloudservices.com/site/myaccount/request/report_graffiti',                    'Graffiti'),
  ('abandoned_vehicle',      'https://manchester.portal.uk.empro.verintcloudservices.com/site/myaccount/request/sr_abandoned_vehicle',               'Abandoned vehicles'),
  ('noise',                  'https://manchester.portal.uk.empro.verintcloudservices.com/site/myaccount/request/sr_noise',                           'Noise problems'),
  ('asb',                    'https://manchester.portal.uk.empro.verintcloudservices.com/site/myaccount/request/sr_antisocial_behaviour',            'Antisocial behaviour')
) as v(slug, url, title)
join public.categories c on c.slug = v.slug;

-- Police forces: deep links to the online ASB form (Single Online Home). Verified in a
-- real browser 2026-09-26 (the site is behind a bot check, so curl gets a 403).
update public.police_forces
   set report_url = 'https://www.gmp.police.uk/ro/report/asb/asb-v3/report-antisocial-behaviour/'
 where id = 'greater-manchester';
