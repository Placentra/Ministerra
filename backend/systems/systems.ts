import { Writer } from './handlers/writer.ts';
import { Catcher } from './handlers/catcher.ts';
import { Cacher } from './handlers/cacher.ts';
import { Socket } from './socket/socket.ts';
import { Sql } from './mysql/mysql.ts';
import { Redis } from './redis/redis.ts';
import { Streamer } from './handlers/streamer.ts';
import { Querer } from './handlers/querer.ts';
import { Emitter } from './handlers/emitter.ts';
import { drainStream } from './handlers/streamUtils.ts';

// SYSTEM EXPORT AGGREGATOR -----------------------------------------------------
// Single import surface for core infrastructure services (SQL, Redis, sockets, stream IO).
// This reduces import sprawl and keeps policy-wrapped services (Writer/Querer/Catcher) consistent.
export { Writer, Catcher, Sql, Redis, Socket, Streamer, Querer, Cacher, Emitter, drainStream };
