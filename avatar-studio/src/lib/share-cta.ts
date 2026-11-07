// The call-to-action button a video's share page or a shared folder's page can carry. A leaf module, so the services
// that both use it can import it without importing each other first.
import { z } from "zod";
import { SHARE_CTA_LABEL_MAX, SHARE_CTA_URL_MAX } from "./types";

/** A call-to-action button on the share page (its text and where it goes), or null for none. */
export const shareCtaSchema = z
  .object({
    label: z.string().trim().min(1, "Give the button some text").max(SHARE_CTA_LABEL_MAX, `Keep the button text to ${SHARE_CTA_LABEL_MAX} characters`),
    url: z
      .string()
      .trim()
      .max(SHARE_CTA_URL_MAX, `Keep the link to ${SHARE_CTA_URL_MAX} characters`)
      .refine((v) => /^https?:\/\/[^\s]+$/i.test(v), "The link must start with http:// or https://"),
  })
  .nullable();
