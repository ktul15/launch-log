/** @type {import('next').NextConfig} */

if (process.env.NODE_ENV === 'production' && !process.env.NEXT_PUBLIC_API_URL) {
  throw new Error('NEXT_PUBLIC_API_URL must be set for production builds')
}

const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        // Widget route must be embeddable in any customer's iframe.
        // frame-ancestors * allows all origins; X-Frame-Options is removed because it
        // conflicts with CSP frame-ancestors when both headers are present.
        source: '/widget/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors *",
          },
          {
            key: 'X-Frame-Options',
            value: '',
          },
        ],
      },
    ]
  },
}

module.exports = nextConfig
