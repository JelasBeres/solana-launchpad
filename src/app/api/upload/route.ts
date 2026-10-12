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

    // 1. Upload directly to Catbox.moe
    try {
      const catboxFormData = new FormData();
      catboxFormData.append("reqtype", "fileupload");
      const userHash = process.env.CATBOX_USERHASH;
      if (userHash && userHash.trim() !== "") {
        catboxFormData.append("userhash", userHash.trim());
      }
      const blob = new Blob([buffer], { type: file.type || "application/octet-stream" });
      catboxFormData.append("fileToUpload", blob, file.name || "token-image.png");

      const catboxRes = await fetch("https://catbox.moe/user/api.php", {
        method: "POST",
        body: catboxFormData,
      });

      if (catboxRes.ok) {
        const catboxUrl = (await catboxRes.text()).trim();
        if (catboxUrl.startsWith("http://") || catboxUrl.startsWith("https://")) {
          return NextResponse.json({
            success: true,
            url: catboxUrl,
            catboxUrl,
          });
        } else {
          console.warn("Catbox upload response text invalid, falling back:", catboxUrl);
        }
      } else {
        console.warn("Catbox upload HTTP status not ok, falling back:", catboxRes.status, await catboxRes.text());
      }
    } catch (catboxErr) {
      console.warn("Catbox upload error, falling back to local storage:", catboxErr);
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
