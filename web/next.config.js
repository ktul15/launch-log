/** @type {import('next').NextConfig} */

if (process.env.NODE_ENV === 'production' && !process.env.NEXT_PUBLIC_API_URL) {
  throw new Error('NEXT_PUBLIC_API_URL must be set for production builds')
}

const nextConfig = {
  reactStrictMode: true,
}

module.exports = nextConfig
