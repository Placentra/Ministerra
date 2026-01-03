# Backend Development Notes

> **Recovered notes** - Originally inline comments, moved to this file for organization.
> These are 3 years of development notes preserved for reference.

---

## Chat Module (`modules/chat.js`)

### TODOs

-   [ ] Add spect to possible frontend chat roles
-   [ ] Store only first letter of role in Hazelcast maps
-   [ ] When banning a user, distribute by web sockets to all online members and show in chat that user was banned temporarily, for perm bans, simply display "user unavailable"
-   [ ] TTL for chat members fetched. Need to reset when user has !lastSync in foundation
-   [ ] Might need to limit chats stored in hazelcast and fetch them from db when needed (cache only chats with activity)
-   [ ] Decide whether to flag deleted messages as del or update content to null and fetch them as well
-   [ ] Probably should handle fetching requests differently, so that function getMembers can be only used for fetching members (+ remove the mode variable)
-   [ ] Check recreating old private chat, not sure if the chat is not locally stored on frontend, that it will work (backend does not send back anything)
-   [ ] Could probably store messages as an array not a map in hazelcast. Same goes for comments
-   [ ] Might use sorted set and instead of score use timestamp for member changes, so that we can fetch punish from redis. Could use combined userID punish as key
-   [ ] Need to reanalyze what happens if a user deletes his account. Both for private chats and other types. Will the other parties correctly update the users status? Will the deleted users name be visible on the message strips?
-   [ ] Probably should get rid of the req and ref flags and add a new column for that
-   [ ] Store new messages into list in the same format that sql updater puts them in the db, in the chatMessCommsWorker
-   [ ] Have to figure out how to cleanup unused user roles in redis (probably put some logic into dailyRecalc)
-   [ ] Cache fetched chat members data with TTL, check that before calling getMembers (or call it inside the getMembers function) invalidate on members change or recache with new data
-   [ ] Add some condition check when connection is not needed (modes or situations)

### BUGs

-   [ ] Need to implement MembersChanged emit (potential replace all other similar emits with it (ban, gag etc.))
-   [ ] Try to create a chat with ourselves - needs investigation

### Ideas

-   When punishing, could maybe check the other members role first from HC and then execute the query

---

## Daily Recalc Task (`tasks/dailyRecalc.js`)

### TODOs

-   [ ] Check user roles need to be handled here as well somehow (like a clean up)
-   [ ] Complete the canceled events cleanup. Probably DONT DO separate logic, maybe simply change flag from 'can' to 'del' and then handle it in the same way as the other events. Or maybe add the logic to the flagChanges handler and at the end of the day, treat it as deleted here.
-   [ ] Might need to clear socketIO rooms for the deleted users here
-   [ ] Implement cleanup for userchatroles
-   [ ] How to properly handle "froUsers" in chat_members? Can't change flag to Fro, because that would overwrite the "del" or "arc" flag etc.
-   [ ] Need to implement deletion of permanently banned user or deleted accounts by us
-   [ ] Cleanup remEve and remUse sets
-   [ ] Update logins.inactive for users that have not logged in for 3 months + delete their redis data. On login, update the logins table and check if they are inactive, if so, recache their redis data. Possibly simply remove the usersummary and check that on login. If its not present, recache everything.
-   [ ] Need to clean up old images (>3 months from users folder - they are stored because of alerts)
-   [ ] Create regular cleanup for possibly unwanted items in sql tables. For example comments, that should have been posted into past_comments, but were posted into regular comments table instead (whatever the reason was)
-   [ ] Implement a minBaseTimeVisibleAfterEnded + extraTimeBecauseEventIsPopular calculation when flagging the pastEvents
-   [ ] Move deleted comments to rem_comments after certain time. DONT FORGET TO UPDATE THE COMMENTS COUNTS for events metas.
-   [ ] Also move images from events to past_events folder
-   [ ] Clear redis of dead chats entries (chatMembers, chatRoles etc. here)
-   [ ] Rethink what actually gets deleted when user is frozen. We might actually want to remove the user completely (same as when deleting) and then on unfreezing, run the user somehow through cacher as if the server was just starting up again. The only time other users need to know, that user is frozen might be in chat_members (which will be synced anyway)

### BUGs

-   [ ] Do we have to take users timezone into account as far as past events are concerned?

---

## Content Helpers (`utilities/contentHelpers.js`)

### TODOs

-   [ ] IMPLEMENT A STAGE ERROR CONTROL - a "checklist" for what was done to start from where it failed
-   [ ] Might need to check for really long responses, by logging metas or linkedUs if they are too long, into a separate table
-   [ ] In free tier, show only a couple of first best users, then skip some and motivate users to buy membership to see all the best
-   [ ] Instead of modifying interests manually, for friendly meeting, could simply sum attendees on frontend, which will be more efficient
-   [ ] Put rank of a user into meta. Give option to be only visible to higher ranked users
-   [ ] CONVERT EVENTS AND USER METAS TO OBJECT WHILE IN THE WORKER, CONVERT IT TO ARRAY (WITHOUT PROPS) AT THE VERY END. It will make it more understandable. OR SECONDARY: create function which accepts what needs to be retrieved (array of property names) and keep the source of truth about meta structure in that function.
-   [ ] Decide whether to fetch members data for previous members (mainly when infinite scrolling to older messages, or just show "user left", 'previous user'. possibly add option to fetch the users data (based on id of the message.user) - this should be a paid feature
-   [ ] How to precisely handle age changes of users? Since those are calculated only when being cached, unless user doesn't change attendance, the age will not be updated
-   [ ] Use the execute with entry function from helpers
-   [ ] MIGHT want to periodically recalc correctness of aggregate columns. (for example chats.requests vs the actual number of requests in the chat_members table)
-   [ ] Divide contentMetas to public and private events and create separate frontend views
-   [ ] Might need to store the sorted eveUserMetas IDs together with eveUserMetas, so that event can quickly fetch userBasics without the need to sort the Metas first
-   [ ] Merge sur and may arrs, and add a flag 'sur' to only surely attending users, absence means only maybe. This simplifies filtering
-   [ ] Refactor meta processing for loops - for each "is" recalced metas need to be passed as a single array, not one by one. Get rid of all the if elses that are unnecessary
-   [ ] Probably revert to storing content ids directly in metas (possibly even basi and deta) to avoid constantly iterating and creating entries before response.
-   [ ] Since now we are using redis hashes, we can remove comments from metas and update them directly in basi hashes. (possibly also other meta props)

### Ideas

-   Could probably create maps for deleted users and ids. Then somehow check against it to help frontend cleanup its cached interactions and other stuff
-   Create a helper function for handling privacy changes on both events and users
-   Store separate cityIDs attendance array in the main userMeta hash, so that distributing city meta versions doesn't require fetching all events cities every time

### Info

-   Need to sort events by relevancy, so that the same events are not constantly at the top (important!)

---

## Foundation Module (`modules/foundation.js`)

### TODOs

-   [ ] Send cities from frontend in 2 separate non-overlapping arrays for got / need data
-   [ ] Rozdělit links na známosti a aktivní zájem - známosti nesynchronizovat, byly by jen pro přehled v profilu
-   [ ] Hodnocení komentářů: cachovat na frontendu ale jen do chvíle, než se změní devID. Pak frontend smazat, poslat flag do discussion, a exekutnout upravenou query, která udělá join a stáhne data. U hodnocení doplnit nějakou time-stampu komentáře aby se vědělo do kdy je platné
-   [ ] For filtered out events might send only id, so that frontend knows which events to remove from brain, because they are completely missing
-   [ ] SEPARATE SETTINGS columns and user data columns into separate tables to speed up the queries
-   [ ] When setting requests, determine in or out based on the order of ids. Then we can skip the calculation here. And frontend would just sort the ids as well to determine
-   [ ] Refactor get or set cities data to only return cityIDs, since frontend already has the rest. Will also simplify "const keys" declaration
-   [ ] Could we maybe get rid of the userAlerts entries in redis altogether and just synchronize the last alert/chat ids in the same ways as we do with interactions? And checking existence would be simply "exists in chats where last_mess > last_seen_alerts.chats or last_alert > last_seen_alerts.others"
-   [ ] Could count rows of missed alerts in the alertsQ and missed chats as well
-   [ ] Need to carefully check TTL for user specific sets/lists in redis (for example alerts should be deleted after some time) and they should have maximum length
-   [ ] Should probably move the devSync value to redis? Otherwise frontend can spoof the time and request the big package again and again
-   [ ] Perform full links / trusts set if users didn't log in the last 3 months. After 3 months clean up tables.

### Info (DO NOT DELETE!)

-   Later we should decide whether to fetch filtering list based on some calculated ratios. Get the sets length and compare it to the number of average filtered out items so that we can better decide whether to use redis inbuilt methods or filter in application layer
-   Basics and details could be cached on demand, while metas should always contain everything. This would allow for more efficient memory management in the future.
-   INFORM USER ON NEW DEV, THAT FOR SECURITY REASON, SOME DATA MIGHT NOT BE AVAILABLE DURING FIRST VISITS.

### Ideas

-   Possibly completely change events card and instead of showing images of users, show topics or properties that are common between users. Use icons or some graphics to make up for images loss. THIS ALLOWS for retrieving only events metas and providing user metas on the fly. This way we can save a lot of data transfer.

---

## Discussion Module (`modules/discussion.js`)

### TODOs

-   [ ] If user receives comment or reply alert while viewing a discussion in Event.jsx, clicking on the toast should scroll to the new comment/reply

### Info

-   When getting only the del flag, there can be stale data on the user and for a very long time, will need to check incoming data for each comment on frontend and update possible changes. Probably might want to create an object holding the discussion members, instead of having the information inside each comment (similarly to chats)

### Ideas

-   Could probably enable batching + autoincrement ids by tracking the current last ID in the application level. Would have to only fetch the last ID from mysql for each batch

---

## JWT Tokens (`modules/jwtokens.js`)

### TODOs

-   [ ] Introduce additional user status "freshUser" which should lower the maximum rating score to 10 instead of 100 and possibly modify other things

---

## Entrance Module (`modules/entrance.js`)

### TODOs

-   [ ] Is creation of ajwt necessary right after change (since the expiry for change jwt is only 5 minutes?)
-   [ ] INFORM USER, that credentials change token will temporarily disable any role the user might have.
-   [ ] Inform user, that unfreezing is in progress (done after daily recalc)

---

## Editor Module (`modules/editor/index.js`)

### TODOs

-   [ ] Need to set lat and lng to cityLat and cityLng if locamode is city (either on client or here)
-   [ ] Should not allow ends to be more than 2 days after starts for friendly events

---

## Socket Chat Handlers (`systems/socket/chatHandlers.js`)

### TODOs

-   [ ] We are always joining all sockets into the room, but we are not informing the other sockets, that they have joined the room (should we???)

---

## Invites Module (`modules/invites.js`)

### TODOs

-   [ ] Probably should somehow batch the invites, so that we don't fetch the same event multiple times with just a different invite

---

## Helpers (`utilities/helpers.js`)

### Notes (from original file)

-   NEED TO SOMEHOW HOLD THE LISTS BETWEEN CALLS OR ENSURE, THAT WE EXECUTE THE FUNCTION ONLY ONCE (NOW THE PROBLEM IS WITH LOADING EVENT)
-   Consider filtering interests of events, that have been filtered out. Currently its not done, would need to push the ids of the events that are filtered out to a set and when filtering inters check if the event is in the set. Currently frontend does that, so there is a little bit of security risk, but negligible, given the processing we save

---

## App.ts (`app.ts`)

### TODOs (from original file)

-   [ ] Need to implement check if previous backup (any of the 3 types) was done on server start, and if not, do it right away.
-   [ ] Import all modules into one file and export a function, which accepts array of names and returns an object with all the modules
-   [ ] Will need to check if server is starting between 00:00 and 00:05, and if so, run the dailyRecalc task right away before starting the server
-   [ ] Redis has geospatial data types, can be used for radius search
-   [ ] Need to implement regular deletion of previous user profiles images (probably every 2-3 months) (so that images can be still loaded for past event users)
-   [ ] Need to check idempotency across the whole backend = if something fails in the middle, it doesn't leave any persistent traces behind (revert redis and revert mysql)

---

## Cacher Handler (`systems/handlers/cacher.js`)

### TODOs

-   [ ] later store more informatino about cities in redis, so that frontend can filter by city parts. ADD another column to events table for part only
-   [ ] find out how persistence works with ioredis. how the FUCK is it possible, that even after multiple restarts, there are old data, which have been deleted from database a week ago!
-   [ ] need to carefuly decide what will be precalculated on server start, there are quite probably some things missing
-   [ ] ANALyze whether we should run tasks here to persis redis into mysql before recalculating everything, if redis didnt go down.

---

_Last updated: December 2024_
_Original location: inline comments across backend modules_
