import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow the app to call the Supabase Edge Function directly
  // No server-side proxying needed — all API calls go to PUBLIC_BASE_URL
};

export default nextConfig;
