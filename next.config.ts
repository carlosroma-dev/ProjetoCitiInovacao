import type { NextConfig } from "next";

const catalogUrl = process.env.SUPABASE_CATALOG_URL;
let catalogRemotePattern: NonNullable<NextConfig["images"]>["remotePatterns"] = [];
if (catalogUrl) {
  try {
    const url = new URL(catalogUrl);
    if (url.protocol === "https:" && /^[a-z0-9-]+\.supabase\.co$/i.test(url.hostname) && url.pathname === "/storage/v1/object/public/catalogo") {
      catalogRemotePattern = [{ protocol: "https", hostname: url.hostname, pathname: "/storage/v1/object/public/catalogo/images/*.webp" }];
    }
  } catch { /* Invalid optional catalog URL leaves local images enabled. */ }
}

const nextConfig: NextConfig = {
  poweredByHeader: false,
  images: { remotePatterns: catalogRemotePattern },
  serverExternalPackages: ["@elevenlabs/elevenlabs-js"],
};

export default nextConfig;
