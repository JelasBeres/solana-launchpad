import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

export const dynamic = "force-dynamic";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IPFS_GATEWAY = process.env.IPFS_PUBLIC_GATEWAY || "https://ipfs.io/ipfs/";

interface MetadataRequest {
  name?: string;
  symbol?: string;
  description?: string;
  imageUrl?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
}

// Blocks obvious internal targets so the image fetch can't be pointed at the server's own network
function isPublicHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
    if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return false;
    if (host === "[::1]" || host.startsWith("[fc") || host.startsWith("[fd")) return false;
    return true;
  } catch {
    return false;
  }
}

async function loadImage(imageUrl: string): Promise<{ blob: Blob; filename: string }> {
  // Files served from /public (e.g. /uploads/* from /api/upload's local fallback, /logo.png)
  if (imageUrl.startsWith("/") && !imageUrl.startsWith("//")) {
    const publicDir = path.join(process.cwd(), "public");
    const filePath = path.normalize(path.join(publicDir, decodeURIComponent(imageUrl.split("?")[0])));
    if (!filePath.startsWith(publicDir + path.sep)) throw new Error("Invalid logo path");
    const filename = path.basename(filePath);
    const buffer = await fs.readFile(filePath);
    if (buffer.length > MAX_IMAGE_BYTES) throw new Error("Image exceeds 5MB limit");
    const ext = path.extname(filename).slice(1).toLowerCase() || "png";
    const type = ext === "jpg" ? "image/jpeg" : ext === "svg" ? "image/svg+xml" : `image/${ext}`;
    return { blob: new Blob([new Uint8Array(buffer)], { type }), filename };
  }

  const resolved = imageUrl.startsWith("ipfs://") ? `${IPFS_GATEWAY}${imageUrl.slice(7)}` : imageUrl;
  if (!isPublicHttpUrl(resolved)) throw new Error("Logo must be a public http(s) image URL");

  const res = await fetch(resolved, { signal: AbortSignal.timeout(15000), redirect: "follow" });
  if (!res.ok) throw new Error(`Could not download logo image (HTTP ${res.status})`);
  const type = res.headers.get("content-type") || "";
  if (!type.startsWith("image/")) throw new Error("Logo URL does not point to an image");
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error("Image exceeds 5MB limit");
  const ext = type.split("/")[1]?.split(";")[0]?.replace("jpeg", "jpg").replace("svg+xml", "svg") || "png";
  return { blob: new Blob([new Uint8Array(buffer)], { type }), filename: `logo.${ext}` };
}

async function pinataUpload(jwt: string, image: { blob: Blob; filename: string }, meta: Record<string, unknown>) {
  const fileForm = new FormData();
  fileForm.append("file", image.blob, image.filename);
  const fileRes = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: fileForm,
  });
  if (!fileRes.ok) throw new Error(`Pinata image upload failed (HTTP ${fileRes.status}): ${(await fileRes.text()).slice(0, 200)}`);
  const { IpfsHash: imageCid } = await fileRes.json();

  const json = { ...meta, image: `${IPFS_GATEWAY}${imageCid}` };
  const jsonRes = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ pinataContent: json, pinataMetadata: { name: `${meta.symbol}-metadata.json` } }),
  });
  if (!jsonRes.ok) throw new Error(`Pinata metadata upload failed (HTTP ${jsonRes.status})`);
  const { IpfsHash: jsonCid } = await jsonRes.json();

  return { metadataUri: `${IPFS_GATEWAY}${jsonCid}`, image: json.image as string };
}

// Fallback: the IPFS endpoint pump.fun's own frontend uses (unofficial, may change)
async function pumpFunUpload(image: { blob: Blob; filename: string }, meta: Record<string, string>) {
  const form = new FormData();
  form.append("file", image.blob, image.filename);
  for (const key of ["name", "symbol", "description", "twitter", "telegram", "website"]) {
    form.append(key, meta[key] || "");
  }
  form.append("showName", "true");

  const res = await fetch("https://pump.fun/api/ipfs", { method: "POST", body: form });
  if (!res.ok) throw new Error(`pump.fun IPFS upload failed (HTTP ${res.status}). Set PINATA_JWT to use Pinata instead.`);
  const data = await res.json();
  if (!data.metadataUri) throw new Error("pump.fun IPFS upload returned no metadataUri");
  return { metadataUri: data.metadataUri as string, image: (data.metadata?.image as string) || "" };
}

// GET /api/metadata?uri=... : reads a token's off-chain metadata JSON server-side (IPFS gateways often block browser CORS)
const jsonCache = new Map<string, { at: number; data: unknown }>();
const FALLBACK_GATEWAYS = ["https://gateway.pinata.cloud/ipfs/", "https://dweb.link/ipfs/", "https://ipfs.io/ipfs/"];

export async function GET(req: NextRequest) {
  const uri = req.nextUrl.searchParams.get("uri") || "";
  const resolved = uri.startsWith("ipfs://") ? `${IPFS_GATEWAY}${uri.slice(7)}` : uri;
  if (!isPublicHttpUrl(resolved)) {
    return NextResponse.json({ error: "Invalid metadata URI" }, { status: 400 });
  }

  const hit = jsonCache.get(resolved);
  if (hit && Date.now() - hit.at < 10 * 60_000) return NextResponse.json(hit.data);

  // Try the original URL first, then other public gateways for the same CID (ipfs.io rate-limits often)
  const cid = resolved.match(/\/ipfs\/([A-Za-z0-9]+)/)?.[1];
  const candidates = [resolved, ...(cid ? FALLBACK_GATEWAYS.map((g) => `${g}${cid}`) : [])].filter(
    (u, i, arr) => arr.indexOf(u) === i
  );

  let lastError = "Failed to fetch metadata";
  for (const url of candidates) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) {
        lastError = `Metadata HTTP ${res.status}`;
        continue;
      }
      const text = await res.text();
      if (text.length > 256 * 1024) return NextResponse.json({ error: "Metadata too large" }, { status: 502 });
      const data = JSON.parse(text);
      jsonCache.set(resolved, { at: Date.now(), data });
      if (jsonCache.size > 2000) jsonCache.clear();
      return NextResponse.json(data);
    } catch (err) {
      lastError = err instanceof Error ? err.message : lastError;
    }
  }
  return NextResponse.json({ error: lastError }, { status: 502 });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as MetadataRequest;
    const name = (body.name || "").trim();
    const symbol = (body.symbol || "").trim().toUpperCase();

    if (!name || name.length > 32) {
      return NextResponse.json({ error: "Name is required (max 32 characters)" }, { status: 400 });
    }
    if (!symbol || symbol.length > 10) {
      return NextResponse.json({ error: "Symbol is required (max 10 characters)" }, { status: 400 });
    }
    if (!body.imageUrl) {
      return NextResponse.json({ error: "A logo image is required for pump.fun coins" }, { status: 400 });
    }

    const image = await loadImage(body.imageUrl.trim());
    const meta = {
      name,
      symbol,
      description: (body.description || "").trim().slice(0, 1000),
      twitter: (body.twitter || "").trim(),
      telegram: (body.telegram || "").trim(),
      website: (body.website || "").trim(),
    };

    // Pinata first when configured; if it fails (revoked key, quota, outage) fall back to pump.fun's IPFS
    const jwt = process.env.PINATA_JWT?.trim();
    if (jwt) {
      try {
        const result = await pinataUpload(jwt, image, { ...meta, showName: true, createdOn: process.env.NEXT_PUBLIC_SITE_URL || "" });
        return NextResponse.json({ success: true, ...result, provider: "pinata" });
      } catch (pinataErr) {
        console.warn("Pinata upload failed, falling back to pump.fun IPFS:", pinataErr instanceof Error ? pinataErr.message : pinataErr);
      }
    }

    const result = await pumpFunUpload(image, meta);
    return NextResponse.json({ success: true, ...result, provider: "pump.fun" });
  } catch (err: unknown) {
    console.error("Metadata upload error:", err);
    const message = err instanceof Error ? err.message : "Metadata upload failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
