// Bumped whenever a message shape, a route or a cache rule changes in a way
// the other side must know about; the remote server refuses a controller
// whose protocol differs instead of misreading it.
export const PROTOCOL_VERSION = 1;
