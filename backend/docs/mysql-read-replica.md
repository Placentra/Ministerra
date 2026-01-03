## MySQL Read Replica Setup

This backend now ships with an opt-in MySQL replica that lives beside the primary database inside `docker-compose.yml`. The goal is to offload heavy `SELECT` traffic without touching most of the application code.

### What was added

-   `mysql-replica` service (MySQL 8) plus a dedicated `mysql-replica-data` volume.
-   `mysql-replica-init` helper container that:
    -   waits for both databases to become healthy,
    -   creates/updates a replication user (`MYSQL_REPLICATION_USER` / `MYSQL_REPLICATION_PASSWORD`),
    -   configures GTID-based replication and starts the replica.
-   Binary logging, GTID mode and row-based replication are enabled on both primary and replica.
-   Backend containers now receive `DB_READ_*` variables and the MySQL layer automatically routes most read-only queries to the replica.

### Running it locally

1. `npm run dev` (root) or `npm --prefix backend run dev` automatically start `mysql-replica` and the `mysql-replica-init` job. `npm run prod` (backend) does the same.
2. Ensure the new secrets exist in your `.env` (or shell):
    - `MYSQL_REPLICATION_USER` (default `replicator`)
    - `MYSQL_REPLICATION_PASSWORD`
    - Optional warmup controls:
        - `DB_READ_WARMUP_TABLE` (defaults to `miscellaneous`) or `DB_READ_WARMUP_SQL`
        - `DB_READ_WARMUP_DELAY_MS` / `DB_READ_WARMUP_RETRY_MS` to change the polling cadence
    - Optional: override `MYSQL_PRIMARY_SERVER_ID` / `MYSQL_REPLICA_SERVER_ID`.
3. For a brand-new database the replica will immediately catch up. For an existing dataset takeWith a fresh `mysqldump` (or use `CLONE`) to seed the replica before letting `mysql-replica-init` run, otherwise replication will start from the current binlog position and older rows will be missing.

The helper container is idempotent and will re-run on each `compose up`. It can be disabled entirely if you prefer to manage replication manually.

> ⚠️ `npm run min` intentionally sticks to a single MySQL instance: `DB_READ_SPLIT` is forced to `0` there and the replica services are not part of the `min` profile.

### Application behaviour

-   The backend exports two pools:
    -   `Sql` → write pool (primary) with automatic read routing.
    -   `SqlRead` → direct access to the replica when you need full control.
-   `Sql.execute` / `Sql.query` now accept an optional third parameter with routing hints:

```js
await Sql.execute('SELECT /*force_primary*/ ...'); // in SQL (comment hint)
await Sql.execute('SELECT ...', [params], { forcePrimary: true });
await Sql.execute('SELECT ...', [params], { forceReplica: true }); // no fallback
```

-   By default, plain `SELECT`/`SHOW`/`EXPLAIN`/`WITH` statements (without `FOR UPDATE`) go to the replica. Everything else stays on the primary.
-   Replica routing now waits for a successful warmup query before turning on, preventing “table does not exist” noise while the replica volume is still seeding.
-   If the replica errors out, the driver logs the issue, falls back to the primary, and temporarily suspends replica usage for `DB_READ_FAILBACK_MS` (defaults to 30s).
-   Set `DB_READ_SPLIT=0` to disable routing but keep the replica container running, or omit `mysql-replica` entirely and point `DB_READ_HOST` back at the primary.

### Monitoring & health

-   Connection health checks now run against both pools and will attempt to rebuild them if a ping fails.
-   Replica stats surface through the existing loggers so you can alert on connection pressure just like the primary pool.

### Operational notes

-   The replica is still on the same physical host in this setup. It removes CPU/IO contention between reads and writes but does **not** provide redundancy if the node dies.
-   Promotion/switchover is out of scope for now; if you need it, add Orchestrator or similar when you move to multi-node deployments.
-   When you hit high write volume, revisit consistency expectations for critical user flows and opt-out via `/*force_primary*/` or `{ forcePrimary: true }` for those specific queries.
