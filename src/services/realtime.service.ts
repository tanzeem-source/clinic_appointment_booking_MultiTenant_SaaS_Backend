import { Request, Response } from "express";

// Live updates over server-sent events (SSE): a one-way stream from the server
// to the browser. Everything here lives in this process's memory, so it works
// for a single running instance. Sharing events between several instances
// needs something like Redis pub/sub (the caching day).

export const MAX_STREAMS_TOTAL = 500;
export const MAX_STREAMS_PER_IP = 10;
const HEARTBEAT_MS = 25_000;

interface StreamClient {
  res: Response;
  ip: string;
  closed: boolean;
}

type Registry = Map<string, Set<StreamClient>>;

export const doctorStreams: Registry = new Map(); // key: doctor id
export const userStreams: Registry = new Map(); // key: user id

let totalStreams = 0;
const streamsPerIp = new Map<string, number>();

export type AvailabilityState =
  | "HELD"
  | "BOOKED"
  | "FREE"
  | "DAY_CLOSED"
  | "DAY_REOPENED"
  | "SCHEDULE_CHANGED"
  | "DOCTOR_CHANGED";

export interface AvailabilityChange {
  state: AvailabilityState;
  date?: string; // "YYYY-MM-DD"
  startTime?: string; // "HH:MM"
}

const writeEvent = (
  client: StreamClient,
  event: string,
  data: unknown,
): void => {
  try {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    // The connection is already gone; its 'close' handler cleans it up.
  }
};

// Starts an event stream on this response and registers it under `key`.
// Returns false, having written nothing, if a connection limit has been
// reached, so the caller can still send a normal error response.
export const openStream = (
  req: Request,
  res: Response,
  registry: Registry,
  key: string,
): boolean => {
  const ip = req.ip ?? "unknown";
  if (
    totalStreams >= MAX_STREAMS_TOTAL ||
    (streamsPerIp.get(ip) ?? 0) >= MAX_STREAMS_PER_IP
  ) {
    return false;
  }

  const client: StreamClient = { res, ip, closed: false };

  if (!registry.has(key)) registry.set(key, new Set());
  registry.get(key)!.add(client);
  totalStreams += 1;
  streamsPerIp.set(ip, (streamsPerIp.get(ip) ?? 0) + 1);

  // Use the RESPONSE's close event: it fires when the browser disconnects.
  // (The request's own close event can fire early on newer Node versions.)
  res.on("close", () => {
    if (client.closed) return;
    client.closed = true;

    const set = registry.get(key);
    if (set) {
      set.delete(client);
      if (set.size === 0) registry.delete(key);
    }

    totalStreams -= 1;
    const remaining = (streamsPerIp.get(ip) ?? 1) - 1;
    if (remaining <= 0) streamsPerIp.delete(ip);
    else streamsPerIp.set(ip, remaining);
  });

  res.status(200).set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // stops nginx-style proxies from holding events back
  });
  res.flushHeaders();
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);

  res.write("retry: 5000\n\n"); // browsers reconnect after 5 seconds
  writeEvent(client, "ready", { at: new Date().toISOString() });

  return true;
};

// A comment line every 25 seconds keeps idle connections from being closed by
// proxies. unref() means this timer never keeps the process alive on its own.
const heartbeat = setInterval(() => {
  for (const registry of [doctorStreams, userStreams]) {
    for (const set of registry.values()) {
      for (const client of set) {
        try {
          client.res.write(": ping\n\n");
        } catch {
          // closed; cleaned up by its close handler
        }
      }
    }
  }
}, HEARTBEAT_MS);
heartbeat.unref();

const publish = (
  registry: Registry,
  key: string,
  event: string,
  payload: Record<string, unknown>,
): void => {
  try {
    const set = registry.get(key);
    if (!set) return;
    const message = { ...payload, at: new Date().toISOString() };
    for (const client of [...set]) writeEvent(client, event, message);
  } catch (err) {
    // Publishing is best-effort and must never break the request that caused it.
    console.error("Failed to publish a live update:", err);
  }
};

// Tell everyone watching this doctor that something about their availability
// changed. Call it AFTER the database commit, never inside a transaction.
export const publishDoctorChange = (
  doctorId: string,
  change: AvailabilityChange,
): void =>
  publish(doctorStreams, doctorId, "availability", { doctorId, ...change });

// Nudge one user's inbox. Only a type is sent; the message itself is read from
// the inbox endpoint. Call it AFTER the database commit.
export const publishToUser = (
  userId: string,
  payload: { type: string },
): void => publish(userStreams, userId, "notification", payload);
