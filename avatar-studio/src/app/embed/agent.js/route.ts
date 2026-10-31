import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const ID = /^agent_[a-z0-9]{6,40}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Website embed: `<script src="https://<app>/embed/agent.js?id=agent_…" async></script>` adds a
 * floating launcher that opens the public talk page in an iframe. Query options: `position`
 * (right | left), `color` (hex), `label` (launcher text, 40 chars).
 */
export function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id") ?? "";
  if (!ID.test(id)) return new NextResponse("// avatar-studio: missing or invalid id", { status: 400, headers: { "Content-Type": "application/javascript; charset=utf-8" } });
  const position = url.searchParams.get("position") === "left" ? "left" : "right";
  const colorParam = url.searchParams.get("color") ?? "";
  const color = HEX.test(colorParam) ? colorParam : "#4f46e5";
  const label = (url.searchParams.get("label") ?? "Chat with us").slice(0, 40);
  const talkUrl = `${url.origin}/talk/${id}?embed=1`;

  const js = `(function () {
  if (document.getElementById("avs-launcher-${id}")) return;
  var talk = ${JSON.stringify(talkUrl)};
  var color = ${JSON.stringify(color)};
  var side = ${JSON.stringify(position)};
  var open = false;
  var frame = document.createElement("iframe");
  frame.title = "Chat with our presenter";
  frame.allow = "autoplay; microphone";
  frame.setAttribute("loading", "lazy");
  frame.style.cssText = "position:fixed;bottom:88px;" + side + ":20px;width:400px;max-width:calc(100vw - 40px);height:640px;max-height:calc(100vh - 110px);border:0;border-radius:16px;box-shadow:0 20px 60px rgba(2,6,23,.35);z-index:2147483646;display:none;background:#020617";
  var btn = document.createElement("button");
  btn.id = "avs-launcher-${id}";
  btn.type = "button";
  btn.setAttribute("aria-haspopup", "dialog");
  btn.setAttribute("aria-expanded", "false");
  btn.textContent = ${JSON.stringify(label)};
  btn.style.cssText = "position:fixed;bottom:20px;" + side + ":20px;z-index:2147483647;padding:12px 18px;border:0;border-radius:999px;background:" + color + ";color:#fff;font:600 14px/1 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 10px 30px rgba(2,6,23,.3);cursor:pointer";
  btn.addEventListener("click", function () {
    open = !open;
    if (open && !frame.src) frame.src = talk;
    frame.style.display = open ? "block" : "none";
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    btn.textContent = open ? "Close" : ${JSON.stringify(label)};
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && open) btn.click();
  });
  function mount() {
    document.body.appendChild(frame);
    document.body.appendChild(btn);
  }
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
})();
`;
  return new NextResponse(js, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
