import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    if (file.size > 5 * 1024 * 1024) {
      return NextResponse.json(
        { error: "File size exceeds 5MB limit" },
        { status: 400 }
      );
    }

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    if (buffer.length === 0) {
      return NextResponse.json({ error: "The image file is empty. Choose the file again." }, { status: 400 });
    }

    // 1. Upload to Catbox.moe. It drops connections now and then, so try a few times before falling back
    // Catbox names files by content hash. When an earlier upload of the same image broke mid-way, that hash
    // keeps pointing at a truncated file, so a retry adds a few trailing bytes (ignored by image decoders)
    // to get a fresh file instead of the broken one.
    let payload: Buffer = buffer;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const catboxFormData = new FormData();
        catboxFormData.append("reqtype", "fileupload");
        const userHash = process.env.CATBOX_USERHASH;
        if (userHash && userHash.trim() !== "") {
          catboxFormData.append("userhash", userHash.trim());
        }
        const blob = new Blob([new Uint8Array(payload)], { type: file.type || "application/octet-stream" });
        catboxFormData.append("fileToUpload", blob, file.name || "token-image.png");

        const catboxRes = await fetch("https://catbox.moe/user/api.php", {
          method: "POST",
          body: catboxFormData,
          signal: AbortSignal.timeout(20000),
        });

        if (catboxRes.ok) {
          const catboxUrl = (await catboxRes.text()).trim();
          if (catboxUrl.startsWith("http://") || catboxUrl.startsWith("https://")) {
            // Catbox sometimes answers with a link to a truncated (even 0-byte) file. The logo URL is written
            // on-chain and cannot be changed later, so only accept it when the hosted file is complete.
            const hosted = await fetch(catboxUrl, { signal: AbortSignal.timeout(20000) });
            const hostedSize = hosted.ok ? (await hosted.arrayBuffer()).byteLength : -1;
            if (hostedSize !== payload.length) {
              console.warn(`Catbox upload attempt ${attempt}: hosted file is ${hostedSize} bytes, expected ${payload.length}`);
              payload = Buffer.concat([buffer, crypto.randomBytes(16)]);
              continue;
            }
            return NextResponse.json({
              success: true,
              url: catboxUrl,
              catboxUrl,
            });
          }
          console.warn(`Catbox upload attempt ${attempt}: invalid response text:`, catboxUrl);
        } else {
          console.warn(`Catbox upload attempt ${attempt}: HTTP ${catboxRes.status}`, await catboxRes.text());
        }
      } catch (catboxErr) {
        console.warn(`Catbox upload attempt ${attempt} failed:`, catboxErr);
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1000));
    }

    // 2. Fallback: Save directly to public/uploads directory on server
    const uploadsDir = path.join(process.cwd(), "public", "uploads");
    await fs.mkdir(uploadsDir, { recursive: true });

    const ext = path.extname(file.name) || ".png";
    const hash = crypto.randomBytes(12).toString("hex");
    const safeFilename = `token-${Date.now()}-${hash}${ext}`;
    const filePath = path.join(uploadsDir, safeFilename);

    await fs.writeFile(filePath, buffer);

    const publicUrl = `/uploads/${safeFilename}`;

    return NextResponse.json({
      success: true,
      url: publicUrl,
      local: true,
    });
  } catch (err: unknown) {
    console.error("Upload handler error:", err);
    const message = err instanceof Error ? err.message : "Internal server error during upload";
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
