-- Export the venue tier mapping from the TicketPortal Supabase project.
--
-- Run this in the TICKETPORTAL project's SQL editor (not this repo's):
--   Dashboard > SQL Editor > New query > paste > Run
-- The editor runs as service_role, so RLS does not filter the rows the way it
-- filters an anon read.
--
-- Copy the single result cell to tools/venue_tiers_export.json, then:
--   python tools/build_venue_tiers.py
-- which regenerates extension/venue-tiers.js.
--
-- Shape matches VENUE_TIER_DATA in extension/venue-tiers.js:
--   { aliases: {alias: canonical},
--     tiers:    {venue: [{tier, sort}, ...]},
--     sections: {venue: {section: [{from, to, tier}, ...]}} }
--
-- Section keys are re-normalized by the Python side to match normSec() in
-- tiers.js, so whatever casing/spacing is stored here is fine.

select json_build_object(

  'aliases', (
    select coalesce(json_object_agg(alias, canonical), '{}'::json)
    from public.venue_aliases
  ),

  'tiers', (
    select coalesce(json_object_agg(venue, tier_list), '{}'::json)
    from (
      select venue,
             json_agg(json_build_object('tier', tier, 'sort', sort) order by sort) as tier_list
      from public.venue_tiers
      group by venue
    ) t
  ),

  'sections', (
    select coalesce(json_object_agg(venue, section_map), '{}'::json)
    from (
      select venue, json_object_agg(section, rules) as section_map
      from (
        -- Whole-section rules (row_from/row_to null) and row bands both land
        -- here; tierFor() tells them apart by the null-ness of from/to.
        select venue,
               section,
               json_agg(json_build_object(
                 'from', row_from,
                 'to',   row_to,
                 'tier', tier
               )) as rules
        from public.venue_sections
        group by venue, section
      ) inner_sections
      group by venue
    ) s
  )

) as venue_tier_data;
