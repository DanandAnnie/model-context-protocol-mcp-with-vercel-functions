// Ready-made script templates. Each one pre-fills the editor.
import type { AspectRatio } from "./types";

export interface ScriptTemplate {
  id: string;
  title: string;
  category: "Real estate" | "Marketing" | "Training" | "Support" | "Social";
  description: string;
  aspect: AspectRatio;
  script: string;
}

export const SCRIPT_TEMPLATES: ScriptTemplate[] = [
  {
    id: "listing-walkthrough",
    title: "Property listing walkthrough",
    category: "Real estate",
    description: "Introduce a listing, highlight three features, and invite a showing.",
    aspect: "9:16",
    script:
      "Welcome to {address}, a {bedrooms}-bedroom home in {neighborhood}. Three things you'll love: the open kitchen with new appliances, the private backyard, and a location minutes from {landmark}. Tours are available this week. Send me a message and I'll get you in.",
  },
  {
    id: "tenant-welcome",
    title: "New tenant welcome",
    category: "Real estate",
    description: "Greet a new tenant and explain how to pay rent and request repairs.",
    aspect: "16:9",
    script:
      "Hi {tenant name}, welcome to {property}! Here's how things work. Rent is due on the first and you can pay online through the portal. For repairs, submit a request in the portal and we'll respond within one business day. If anything urgent comes up, call the number in your lease. We're glad you're here.",
  },
  {
    id: "product-launch",
    title: "Product launch announcement",
    category: "Marketing",
    description: "Announce a new product with one benefit, one proof point, and a call to action.",
    aspect: "16:9",
    script:
      "Today we're launching {product}. It helps {audience} {core benefit} without {main pain}. Early customers cut {metric} by {number} percent in the first month. Try it free at {website} and let us know what you think.",
  },
  {
    id: "onboarding-step",
    title: "Onboarding tutorial step",
    category: "Training",
    description: "Explain one task in a tool, step by step.",
    aspect: "16:9",
    script:
      "In this short lesson you'll learn how to {task}. First, open {screen}. Second, click {control} and enter {value}. Third, save and confirm the change appears in {location}. That's it. In the next lesson we'll cover {next topic}.",
  },
  {
    id: "faq-answer",
    title: "Support FAQ answer",
    category: "Support",
    description: "Answer one common customer question clearly.",
    aspect: "1:1",
    script:
      "A common question we get is: {question}? The short answer is {answer}. Here's why: {reason}. If you need more help, reply to this message or visit {help center link}.",
  },
  {
    id: "social-tip",
    title: "Quick tip for social",
    category: "Social",
    description: "A 20-second vertical tip with a hook and a payoff.",
    aspect: "9:16",
    script:
      "Here's a mistake most people make with {topic}. They {mistake}. Instead, try this: {better approach}. It takes two minutes and {benefit}. Follow for more tips like this.",
  },
  {
    id: "market-update",
    title: "Monthly market update",
    category: "Real estate",
    description: "Summarize local market numbers and what they mean for buyers and sellers.",
    aspect: "16:9",
    script:
      "Here's your {month} market update for {area}. The median sale price is {price}, {direction} {percent} percent from last year. Homes are selling in about {days} days. For sellers, that means {seller takeaway}. For buyers, {buyer takeaway}. Questions? Reach out anytime.",
  },
  {
    id: "event-invite",
    title: "Event invitation",
    category: "Marketing",
    description: "Invite viewers to a webinar, open house, or meetup.",
    aspect: "1:1",
    script:
      "You're invited to {event} on {date} at {time}. We'll cover {topic one}, {topic two}, and leave time for your questions. Spots are limited, so register at {link} today. See you there.",
  },
];

export function findTemplate(id: string | null | undefined): ScriptTemplate | undefined {
  return id ? SCRIPT_TEMPLATES.find((t) => t.id === id) : undefined;
}
