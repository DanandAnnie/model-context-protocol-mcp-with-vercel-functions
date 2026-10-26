// Commands the browser sends a LiveAvatar session over the LiveKit room's data channel.

/** LiveAvatar takes commands on this data channel topic. */
export const COMMAND_TOPIC = "agent-control";

/** A reply as LiveAvatar's `avatar.speak_text` command, which says the text as written. */
export function speakCommand(text: string, eventId: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ event_id: eventId, event_type: "avatar.speak_text", text }));
}
