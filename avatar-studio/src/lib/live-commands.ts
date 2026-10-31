// Commands the browser sends a LiveAvatar session over the LiveKit room's data channel, and the events it reads back.

/** LiveAvatar takes commands on this data channel topic. */
export const COMMAND_TOPIC = "agent-control";
/** LiveAvatar reports on this topic, among other things that it stopped the session. */
export const RESPONSE_TOPIC = "agent-response";

/** A reply as LiveAvatar's `avatar.speak_text` command, which says the text as written. */
export function speakCommand(text: string, eventId: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ event_id: eventId, event_type: "avatar.speak_text", text }));
}

/** A command's id: a UUID, with the same fallback as LiveAvatar's SDK where the page is not a secure context. */
export function commandId(random: () => number = Math.random): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Whether a message on the response topic says LiveAvatar ended the session. */
export function isSessionStopped(payload: Uint8Array): boolean {
  try {
    return (JSON.parse(new TextDecoder().decode(payload)) as { event_type?: string }).event_type === "session.stopped";
  } catch {
    return false;
  }
}
