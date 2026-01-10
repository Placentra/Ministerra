## Goal
Refactor the schema to use Snowflake IDs everywhere for:

- **Maximum scalability** (sharding-ready, no coordination needed)
- **Zero collision by construction** (worker partitioning)
- **Time-ordered IDs** (chronological sorting, range queries)
- **Compact storage** (64-bit BIGINT vs 128-bit ULID or 168-bit NanoID-21)

## ID Strategy: Snowflake

All primary keys now use 64-bit Snowflake IDs generated at the application layer.

### Snowflake Layout (64 bits)
```
[1 bit sign][41 bits timestamp][10 bits worker ID][12 bits sequence]
```

- **Sign bit**: Always 0 (positive)
- **Timestamp**: Milliseconds since 2024-01-01 (~69 years range, valid until ~2093)
- **Worker ID**: 0-1023 (supports 1024 concurrent nodes)
- **Sequence**: 0-4095 (supports 4096 IDs per millisecond per worker)

### Capacity
- 4,096,000 IDs/second per worker
- ~4 billion IDs/second cluster-wide
- No coordination needed between workers

### Benefits
1. **Unique by construction**: Each worker has a dedicated partition of the ID space
2. **No DB round-trip**: Generate ID → INSERT → done (no collision retry needed)
3. **Time-ordered**: IDs sort chronologically (enables efficient cursor pagination)
4. **Compact**: Fits in MySQL BIGINT with efficient B-tree indexing

## Migration

### Pre-Launch (Clean Slate)
Apply `backend/migrations/2026-01-04_0001_snowflake_ids.sql`:
- Drops all foreign keys
- Converts all `INT`/`VARCHAR` ID columns to `BIGINT`
- Removes `AUTO_INCREMENT` from all tables
- Recreates foreign keys

### Production (With Data)
Would require a staged migration:
1. Add new `bigint_id` column
2. Backfill with converted IDs
3. Switch application to use new column
4. Drop old column and rename

## Application Changes

### ID Generator (`backend/utilities/idGenerator.ts`)
```typescript
import { generateIDString } from '../utilities/idGenerator';

// Generate a new ID
const userID = generateIDString();  // "1234567890123456789"

// Extract timestamp from ID (for debugging)
import { extractTimestamp } from '../utilities/idGenerator';
const created = extractTimestamp(userID);  // Date object
```

### Worker ID Configuration
Set `WORKER_ID` environment variable (0-1023) for each node.
Falls back to `hostname hash + PID` for local development.

```bash
# Docker Swarm / K8s
WORKER_ID=42

# Local dev (auto-derived from hostname + PID)
# No config needed
```

## Tables Converted

| Table | Old ID Type | New ID Type |
|-------|-------------|-------------|
| users | varchar(8) | bigint |
| events | varchar(8) | bigint |
| chats | int AUTO_INCREMENT | bigint |
| messages | bigint (redis.incr) | bigint (Snowflake) |
| comments | int AUTO_INCREMENT | bigint |
| user_alerts | int AUTO_INCREMENT | bigint |
| reports | int AUTO_INCREMENT | bigint |
| chat_invites | int AUTO_INCREMENT | bigint |
| user_devices | int AUTO_INCREMENT | bigint |
| eve_feedback_user | bigint AUTO_INCREMENT | bigint |

All foreign key columns also converted to BIGINT for type consistency.

## Redis Key Changes

- Removed: `lastMessID` (no longer needed)
- ID values in Redis hashes/sets now contain string representations of 64-bit integers
