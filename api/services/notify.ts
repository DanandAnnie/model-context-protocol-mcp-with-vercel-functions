// Lightweight Telegram notifier for instant operator alerts.
// No-ops cleanly (returns false) when TELEGRAM_BOT_TOKEN is not configured,
// so callers never have to guard the call site.

export async function sendTelegram(text: string): Promise<boolean> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID || "8208280469";
  if (!botToken) {
    console.warn("[NOTIFY] TELEGRAM_BOT_TOKEN not set — skipping Telegram alert");
    return false;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    });
    if (!res.ok) {
      console.error(`[NOTIFY] Telegram ${res.status}: ${await res.text()}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[NOTIFY] Telegram send failed:", (e as Error).message);
    return false;
  }
}
