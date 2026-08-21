import { NextResponse } from "next/server";
import { getSessionUser, requestContext } from "@/lib/auth";
import { readDocument } from "@/server/documents";
import { AppError } from "@/lib/errors";

/**
 * Protected document delivery. Access is re-checked per request against the
 * document's confidentiality and the caller's permissions, and every attempt —
 * including denials — is logged.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const download = new URL(req.url).searchParams.has("download");
  const { ip } = await requestContext();

  try {
    const { doc, buf } = await readDocument(user, id, download ? "DOWNLOAD" : "VIEW", ip);
    const filename = doc.originalFilename.replace(/["\\r\n]/g, "_");
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": doc.mimeType,
        "Content-Length": String(buf.byteLength),
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${filename}"`,
        // Never cache confidential procurement documents in shared caches.
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    if (e instanceof AppError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
    }
    return NextResponse.json({ error: "Document could not be read." }, { status: 500 });
  }
}
