# Database additions (applied to Supabase project layover-logbook)

## Anti-spam (migration `crew_antispam_triggers`)
Triggers that run before a row is added, on top of the daily limits already in `crew_post_add` and `crew_comment_add`:
- `crew_posts`: at most 3 posts in 10 minutes, at most 1 link, no identical post within 24 hours.
- `crew_comments`: at most 10 comments in 5 minutes, at most 1 link, no identical comment on the same post within 1 hour.
- `crew_post_reports`: at most 20 reports in 24 hours.

## Visit counting (migration `cookieless_page_views`)
- Table `page_views`: page path, referring domain, 2-letter language, device type, first-page-of-visit flag, time. No IP, no user id, no cookie. RLS on with no policies, so it can't be read or written directly.
- `track_view(...)`: called by `/analytics.js` on every page; checks and cleans the values, ignores floods.
- `site_stats(p_days)`: totals, views per day, top pages, referrers, devices and languages. Only works for an owner listed in `crew_owners`; shown in the app under Notebook → Account and data → Site statistics.

## Off together roster sharing (migrations `roster_sharing_off_together`, `roster_sharing_fix_days_check`)
Crew share only day types (O off, L leave, P part day, S standby, D duty, A away, - unknown), never flights, routes or times.
- `roster_shares`: one row per user: display name, first day, the day string (max 400 days) and a private 10-character code.
- `roster_links`: who may see whose days (owner -> viewer). Connecting with a code adds both directions.
- `roster_connect_attempts`: limits code guesses to 20 an hour per user.
- RLS is on with no policies, so the tables can only be reached through these functions (signed-in users only):
  `roster_publish(name, start, days)` returns my code · `roster_connect(code)` · `roster_friends()` (Pro when the paywall is on) ·
  `roster_mine()` · `roster_disconnect(friend)` · `roster_new_code()` · `roster_unpublish()`.
- Rows are removed with the account (`on delete cascade`).

## Crew chat (`backend/crew-chat.sql`)
Floating chat for invited crew (`chat.js`). Rooms: `lounge` and `city:<destination>`.
- `crew_messages` (room, sender, text up to 500, optional photo in the `crew-photos` bucket, hidden flag) and `crew_message_reports` (3 reports hide a message).
- Functions (signed-in crew only, checked with `_crew_only()`): `crew_chat_send`, `crew_chat_list`, `crew_chat_delete` (own messages, owners any), `crew_chat_report`.
- Limits: 8 messages a minute, one link per message, no repeats within 30 seconds.
- The app keeps the chat bubble hidden until these functions exist.

## Connect your AI: MCP server (migrations `ai_keys_for_mcp`, `ai_key_create_plain_error`; Edge Function `mcp`)
Pro feature. Lets an AI assistant (Claude, ChatGPT, Cursor, any MCP app) read the user's own logbook and add expenses or wishlist items.
- `ai_keys`: one row per key: name, SHA-256 fingerprint of the key (never the key itself), last 4 characters, last use, a per-minute call counter. RLS on with no policies.
- `ai_key_create(p_name)`, `ai_key_list()`, `ai_key_revoke(p_id)`: called by the app (Notebook → Connect your AI). Creating needs Pro when the paywall is on; up to 5 keys per user.
- `ai_resolve(p_hash)`, `ai_tx_add(p_uid, p_item)`, `ai_wish_add(p_uid, p_code, p_item)`: service role only, used by the Edge Function. Writes are atomic appends to `user_data`, tagged `via:"ai"` with a time `at`, so the app merges them in before it next saves (see `mergeAI` in app.html).
- Edge Function `mcp` (`backend/mcp.ts`, JWT verification off, it checks the key itself): Model Context Protocol over HTTP at
  `https://zzgtxastnmxzffygdkrg.supabase.co/functions/v1/mcp`. Key as `Authorization: Bearer llb_...` or `?key=llb_...`. 120 calls a minute per key.
- Tools: get_overview, list_layovers, get_layover_plan, spending_summary, list_expenses, add_expense, get_city_notes, add_wishlist_item.
