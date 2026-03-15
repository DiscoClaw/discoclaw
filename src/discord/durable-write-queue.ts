import { KeyedQueue } from '../group-queue.js';

// Shared write queue for durable memory. Serializes writes per userId so
// concurrent callers (memory-commands, user-turn-to-durable, etc.) don't race.
export const durableWriteQueue = new KeyedQueue();
