/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: [
    "@electric-sql/pglite",
    "postgres",
    "stream-json",
    "stream-chain",
    "unbzip2-stream",
  ],
  webpack: (config, { dev }) => {
    if (dev) {
      config.watchOptions = {
        ...config.watchOptions,
        ignored: ["**/.data/**", "**/node_modules/**", "**/.git/**"],
      };
    }
    return config;
  },
};

export default nextConfig;
