-- Categories (PLAN.md §3). Slugs, groups and routing targets are a shared
-- contract with the app and edge functions: do not rename.
--
-- extra_fields: array of { key, label, type: text|select|date, required, options?, hint? }.
-- Values are stored in reports.extra (jsonb object keyed by `key`).

insert into public.categories
  (slug, category_group, name, description, routing_target, public, hide_exact_location,
   urgent, requires_address, safety_interstitial, extra_fields, sort_order)
values
  -- Roads & pavements
  ('pothole', 'roads', 'Pothole',
   'A hole or broken surface in the road carriageway, including sunken or crumbling tarmac.',
   'highway', true, false, false, false, false, '[]', 10),
  ('damaged_pavement', 'roads', 'Damaged pavement',
   'Broken, cracked, uneven or loose paving slabs, kerbs or footpath surfaces that are a trip hazard.',
   'highway', true, false, false, false, false, '[]', 20),
  ('road_markings_signs', 'roads', 'Road markings / signs',
   'Faded or missing road markings, or damaged, missing, dirty or obscured road signs.',
   'highway', true, false, false, false, false, '[]', 30),

  -- Waste
  ('missed_bin', 'waste', 'Missed bin collection',
   'A household bin, box or bag that was put out on the right day but not collected.',
   'waste_collection', true, false, false, true, false,
   '[{"key":"bin_type","label":"Which bin was missed?","type":"select","required":true,
      "options":["General waste","Recycling","Garden waste","Food waste","Glass","Other"]},
     {"key":"collection_date","label":"Collection day","type":"date","required":false}]', 40),
  ('fly_tipping', 'waste', 'Fly-tipping',
   'Rubbish, furniture, rubble or other waste dumped illegally on streets, verges or open land.',
   'waste_collection', true, false, false, false, false,
   '[{"key":"waste_type","label":"What has been dumped?","type":"select","required":false,
      "options":["Household rubbish","Furniture","White goods","Building rubble","Garden waste","Tyres","Asbestos (suspected)","Other"]},
     {"key":"size","label":"How much?","type":"select","required":false,
      "options":["Single item","Car boot load","Small van load","Lorry load or more"]}]', 50),
  ('overflowing_litter_bin', 'waste', 'Overflowing litter bin',
   'A public litter or dog bin on the street or in a park that is full, overflowing or damaged.',
   'waste_collection', true, false, false, false, false, '[]', 60),
  ('dog_fouling', 'waste', 'Dog fouling',
   'Dog mess left on a pavement, path, verge or public open space.',
   'waste_collection', true, false, false, false, false, '[]', 70),

  -- Street scene
  ('graffiti', 'street_scene', 'Graffiti',
   'Graffiti, tags or fly-posting on walls, street furniture or other public-facing surfaces.',
   'district_or_unitary', true, false, false, false, false,
   '[{"key":"offensive","label":"Is it offensive or racist?","type":"select","required":false,
      "options":["No","Yes"]}]', 80),
  ('street_light', 'street_scene', 'Broken street light',
   'A street light that is out, flickering, on during the day, or has a damaged column or cover.',
   'highway', true, false, false, false, false,
   '[{"key":"column_number","label":"Number on the lamp post","type":"text","required":false,
      "hint":"Usually on a small plate on the post"}]', 90),
  ('abandoned_vehicle', 'street_scene', 'Abandoned vehicle',
   'A vehicle that looks abandoned: untaxed, damaged, burnt out, or not moved for a long time.',
   'district_or_unitary', true, false, false, false, false,
   '[{"key":"registration","label":"Registration number","type":"text","required":true},
     {"key":"make_model","label":"Make and model","type":"text","required":false},
     {"key":"colour","label":"Colour","type":"text","required":false}]', 100),
  ('overgrown_vegetation', 'street_scene', 'Overgrown vegetation',
   'Trees, hedges, weeds or grass overhanging or blocking a road, pavement, sign or sightline.',
   'highway', true, false, false, false, false, '[]', 110),

  -- ASB / community safety
  ('asb', 'community_safety', 'Anti-social behaviour',
   'Ongoing anti-social behaviour such as intimidation, vandalism, street drinking or nuisance gatherings (not an emergency).',
   'asb', true, true, false, false, true, '[]', 120),
  ('noise', 'community_safety', 'Noise nuisance',
   'Persistent noise such as loud music, parties, barking dogs, alarms or construction outside permitted hours.',
   'district_or_unitary', true, true, false, false, false,
   '[{"key":"noise_source","label":"Source of the noise","type":"select","required":false,
      "options":["Music or parties","Dog barking","Alarm","Construction","Commercial premises","Vehicles","Other"]},
     {"key":"when","label":"When does it happen?","type":"text","required":false}]', 130),
  ('drug_litter', 'community_safety', 'Drug litter / needles',
   'Discarded needles, syringes or other drug-related litter in a public place. Do not touch it.',
   'waste_collection', true, false, true, false, true, '[]', 140)
on conflict (slug) do update set
  category_group      = excluded.category_group,
  name                = excluded.name,
  description         = excluded.description,
  routing_target      = excluded.routing_target,
  public              = excluded.public,
  hide_exact_location = excluded.hide_exact_location,
  urgent              = excluded.urgent,
  requires_address    = excluded.requires_address,
  safety_interstitial = excluded.safety_interstitial,
  extra_fields        = excluded.extra_fields,
  sort_order          = excluded.sort_order;
