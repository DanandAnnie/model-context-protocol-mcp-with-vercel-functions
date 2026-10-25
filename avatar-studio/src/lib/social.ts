// Links that post a video's share page to a social network or a mail client. Each opens the network's
// own compose screen with the link filled in; nothing is posted until the person confirms there.

export type SocialNetwork = "linkedin" | "x" | "facebook" | "whatsapp" | "email";

export interface SocialLink {
  network: SocialNetwork;
  label: string;
  href: string;
}

/** Half of a surrogate pair with no other half, as a title cut mid-emoji ends with; `encodeURIComponent` throws on one. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** The share links for a public URL and a title, in the order the video page shows them. */
export function socialShareLinks(url: string, title: string): SocialLink[] {
  const u = encodeURIComponent(url);
  const text = title.replace(LONE_SURROGATE, "").trim();
  return [
    { network: "linkedin", label: "LinkedIn", href: `https://www.linkedin.com/sharing/share-offsite/?url=${u}` },
    { network: "x", label: "X", href: `https://x.com/intent/post?url=${u}${text ? `&text=${encodeURIComponent(text)}` : ""}` },
    { network: "facebook", label: "Facebook", href: `https://www.facebook.com/sharer/sharer.php?u=${u}` },
    { network: "whatsapp", label: "WhatsApp", href: `https://wa.me/?text=${encodeURIComponent(text ? `${text} ${url}` : url)}` },
    { network: "email", label: "Email app", href: `mailto:?subject=${encodeURIComponent(text || "A video for you")}&body=${encodeURIComponent(url)}` },
  ];
}
