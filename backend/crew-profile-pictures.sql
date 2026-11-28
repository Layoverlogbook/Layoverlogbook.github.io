-- Layover Logbook: crew profile pictures (migration `crew_profile_pictures`).
-- A member's picture is a square JPEG in the private crew-photos bucket at <uid>/avatar-<uuid>.jpg
-- (the existing storage rules already limit uploads to your own folder and viewing to crew members).
-- crew_profiles.avatar holds the path; feed, comments, profiles and follower lists return it as "av".
alter table public.crew_profiles add column avatar text
  check (avatar is null or avatar ~ '^[0-9a-f-]{36}/avatar-[0-9a-f-]{36}\.jpg$');
-- crew_set_avatar(p_path): set or clear (null) your picture; returns the old path so the app can delete the old file.
-- _crew_feed2, _crew_comments_for, crew_profile and crew_follow_list were re-created to include the picture
-- (same bodies as backend/crew-follows-deals.sql plus "av"; _crew_feed2 also returns "me_av").
