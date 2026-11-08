import { errorResponse, json, readJson } from "@/lib/api-utils";
import { publicOrigin } from "@/lib/config";
import { requireEditor, requireOwner } from "@/lib/owner";
import { collectionSchema, listCollections, shareFolder } from "@/lib/services";
import { collectionJson } from "@/lib/collection-json";

export const dynamic = "force-dynamic";

const withUrl = collectionJson;

/** The shared folders of the account or workspace, each with its public link. */
export async function GET(req: Request) {
  try {
    const owner = await requireOwner();
    const origin = publicOrigin(req);
    return json({ collections: (await listCollections(owner)).map((c) => withUrl(c, origin)) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Shares a folder (`{ folder }`): `201` with a new link, or `200` with the one it already has. Editors only. */
export async function POST(req: Request) {
  try {
    const owner = await requireEditor();
    const { collection, created } = await shareFolder(collectionSchema.parse(await readJson(req)), owner);
    return json({ collection: withUrl(collection, publicOrigin(req)) }, { status: created ? 201 : 200 });
  } catch (err) {
    return errorResponse(err);
  }
}
